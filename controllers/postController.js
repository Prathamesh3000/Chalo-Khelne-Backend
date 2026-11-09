const Post = require('../src/modules/social/models/Post');
const escapeRegex = require('../utils/escapeRegex');
const Tournament = require('../src/modules/tournaments/models/Tournament'); // Add Tournament model
const User = require('../src/modules/identity/models/User'); // Add User model
const { Manager } = require('../src/modules/identity/models/ClubManager'); // Add Manager model
const playerHistory = require('../services/playerHistoryService');
const { notifyPlayer } = require('../utils/playerNotify');
const { getRelativePath, cleanupFile } = require('../middleware/uploads');
const axios = require('axios');
const cheerio = require('cheerio');
const { default: mongoose } = require('mongoose');

// §3.10.3 — list endpoints are paginated with a default limit.
const { paginatedFind } = require("../utils/pagination");

// Helper function to fetch link preview data
const fetchLinkPreview = async (url) => {
  try {
    const response = await axios.get(url);
    const html = response.data;
    const $ = cheerio.load(html);

    const getMetaTag = (name) => {
      return $(`meta[name=${name}]`).attr('content') ||
        $(`meta[property="og:${name}"]`).attr('content') ||
        $(`meta[property="twitter:${name}"]`).attr('content');
    };

    return {
      title: getMetaTag('title') || $('title').text(),
      description: getMetaTag('description'),
      image: getMetaTag('image'),
      url: url
    };
  } catch (error) {
    console.error('Error fetching link preview:', error);
    return null;
  }
};

// Multipart bodies deliver lists as one value, a repeated field, or a JSON
// string; JSON bodies deliver real arrays. Accept all of them.
const toList = (v) => {
  if (v === undefined || v === null || v === '') return [];
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim().startsWith('[')) {
    try { return JSON.parse(v); } catch (_) { /* fall through */ }
  }
  return [v];
};

exports.createPost = async (req, res) => {
  const uploaded = req.files || [];
  const discardUploads = () => uploaded.forEach((f) => cleanupFile(f.path));
  try {
    const { tournamentName, caption, tags, location, link, eventDate } = req.body;
    const taggedUserIds = toList(req.body.taggedUserIds);

    if (eventDate && Number.isNaN(new Date(eventDate).getTime())) {
      discardUploads();
      return res.status(400).json({ message: 'eventDate is not a valid date' });
    }

    // 1. Check if tournament exists in DB - search by title or name (case-insensitive)
    const tournament = await Tournament.findOne({
      $or: [
        { title: { $regex: new RegExp(`^${escapeRegex(tournamentName.trim())}$`, 'i') } },
        { name: { $regex: new RegExp(`^${escapeRegex(tournamentName.trim())}$`, 'i') } }
      ]
    });

    if (!tournament) {
      console.log("Post creation failed: Tournament not found ->", tournamentName);
      discardUploads();
      return res.status(400).json({
        message: `Tournament "${tournamentName}" not found. Please select from the suggestions.`
      });
    }

    // 2. Validate tags if provided (optional validation)
    let tagList = [];
    if (tags) {
      tagList = toList(tags);
      // We'll keep the tags as strings even if users aren't found in DB, 
      // but let's log any that aren't found if we want to be helpful.
    }

    // 3. Fetch link preview if link is provided
    let linkPreview = null;
    if (link) {
      linkPreview = await fetchLinkPreview(link);
    }

    // 4. Create post
    const authorIsPlayer = req.userRole === 'User';
    const authorId = req.user.id;
    const taggedUsers = await playerHistory.resolveTaggedUsers(taggedUserIds, authorId);

    const post = new Post({
      tournamentName: tournament.title || tournament.name || tournamentName,
      caption,
      tags: tagList,
      taggedUsers,
      eventDate: eventDate ? new Date(eventDate) : undefined,
      images: uploaded.map((f) => getRelativePath(f.path)),
      location,
      link,
      linkPreview,
      user: req.user.id,
      // allowUserOrManager sets req.userRole to 'Manager' | 'User' | 'SuperAdmin'.
      // Manager schema has no `role` field, so req.user.role is undefined for
      // Manager tokens — use req.userRole as the source of truth.
      userModel: req.userRole === 'Manager' ? 'Manager' : 'User'
    });

    await post.save();

    // 5. Timeline: the author's own entry is ACTIVE, every tagged player gets a
    // PENDING one they must approve. The post is already saved and is the
    // primary result, so a history failure is logged rather than failing the
    // request — the entries can be re-derived from the post.
    try {
      const entries = await playerHistory.recordFromPost({
        post,
        tournament,
        authorId,
        authorIsPlayer,
        taggedUserIds: taggedUsers,
      });

      // Tell each tagged player there is something to approve. notifyPlayer
      // saves it, emits over the socket and sends the Expo push, and never
      // throws — a notification problem must not affect the post.
      const authorName = req.user.name || 'Someone';
      for (const entry of entries.filter((e) => e && e.status === 'pending')) {
        await notifyPlayer(req.app, entry.user, {
          type: 'history_tag',
          title: 'You were tagged in a post',
          message: `${authorName} tagged you in a post about ${post.tournamentName}. Review it to add it to your playing history.`,
          data: {
            historyId: String(entry._id),
            postId: String(post._id),
            tournamentName: post.tournamentName,
            senderName: authorName,
          },
        });
      }
    } catch (historyErr) {
      console.error("Player history record failed for post", String(post._id), historyErr);
    }

    res.status(201).json(post);

  } catch (error) {
    console.error("Create post error:", error);
    discardUploads();
    res.status(400).json({ message: error.message });
  }
};

// Rest of the controller remains the same
exports.getAllPosts = async (req, res) => {
  try {
    const posts = await paginatedFind(Post, req, res, {
      sort: { createdAt: -1 },
      populate: [
        { path: 'user', select: 'name profileImage' },
        { path: 'likes', select: 'name' },
        { path: 'saves', select: 'name' },
        { path: 'comments.user', select: 'name profileImage' },
      ],
    });
    res.json(posts);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.toggleLike = async (req, res) => {
  try {
    const postId = req.params.postId;
    const userId = req.user.id;

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    const likeIndex = post.likes.indexOf(userId);
    if (likeIndex === -1) {
      post.likes.push(userId);
    } else {
      post.likes.splice(likeIndex, 1);
    }

    await post.save();
    res.json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

exports.toggleSave = async (req, res) => {
  try {
    const postId = req.params.postId;
    const userId = req.user.id;

    // Find the post
    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: 'Post not found' });
    }

    // Try to find user in both User and Manager models
    let user = await User.findById(userId);
    let isManager = false;

    if (!user) {
      user = await Manager.findById(userId);
      isManager = true;
    }

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Check if post is already saved
    const saveIndex = post.saves.indexOf(userId);
    const userSaveIndex = user.savedPosts ? user.savedPosts.indexOf(postId) : -1;

    if (saveIndex === -1) {
      // Save the post
      post.saves.push(userId);
      if (!user.savedPosts) {
        user.savedPosts = [];
      }
      user.savedPosts.push(postId);
    } else {
      // Unsave the post
      post.saves.splice(saveIndex, 1);
      if (userSaveIndex !== -1) {
        user.savedPosts.splice(userSaveIndex, 1);
      }
    }

    // Save both documents
    await post.save();
    await user.save();

    res.json(post);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// GET /api/posts/:userId
exports.getPostsByUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // 👇 correct field name
    const posts = await Post.find({ user: userId }).sort({ createdAt: -1 }).populate('user', 'name profileImage');

    res.json({ success: true, posts });
  } catch (err) {
    console.error("Error fetching user posts:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

// GET /api/posts/saved/:userId
exports.getSavedPostsByUser = async (req, res) => {
  try {
    const { userId } = req.params;

    // Query posts where this user is in the saves array
    const posts = await Post.find({ saves: userId })
      .populate("user", "name profileImage email")
      .populate("comments.user", "name profileImage")
      .sort({ createdAt: -1 });

    res.json({ success: true, posts });
  } catch (err) {
    console.error("Error fetching saved posts:", err);
    res.status(500).json({ success: false, message: err.message });
  }
};

exports.addComment = async (req, res) => {
  try {
    const { postId } = req.params;
    const { text } = req.body;
    const userId = req.user.id;

    if (!text || !text.trim()) {
      return res.status(400).json({ message: "Comment text is required" });
    }

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    const newComment = {
      user: userId,
      text: text,
      createdAt: new Date()
    };

    post.comments.push(newComment);
    await post.save();

    // Populate user details for the new comment to return it immediately
    await post.populate({
      path: 'comments.user',
      select: 'name profileImage'
    });

    res.status(201).json({
      success: true,
      comments: post.comments,
      newComment: post.comments[post.comments.length - 1]
    });
  } catch (error) {
    console.error("Error adding comment:", error);
    res.status(500).json({ message: error.message });
  }
};

exports.deleteComment = async (req, res) => {
  try {
    const { postId, commentId } = req.params;
    const userId = req.user.id || req.user._id;
    const isSuperAdmin =
      req.isSuperAdmin === true ||
      String(req.user?.role || "").toLowerCase() === "superadmin";

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ success: false, message: "Post not found" });
    }

    const comment = post.comments.id(commentId);
    if (!comment) {
      return res.status(404).json({ success: false, message: "Comment not found" });
    }

    // The comment author, the post owner, or a SuperAdmin (moderation) may delete.
    const isCommentAuthor = String(comment.user) === String(userId);
    const isPostOwner = String(post.user) === String(userId);
    if (!isCommentAuthor && !isPostOwner && !isSuperAdmin) {
      return res
        .status(403)
        .json({ success: false, message: "Unauthorized to delete this comment" });
    }

    post.comments.pull({ _id: commentId });
    await post.save();
    await post.populate({ path: "comments.user", select: "name profileImage" });

    return res.json({ success: true, comments: post.comments });
  } catch (error) {
    console.error("Error deleting comment:", error);
    res.status(500).json({ success: false, message: error.message });
  }
};

exports.deletePost = async (req, res) => {
  try {
    const { postId } = req.params;
    // SuperAdmin actors come through allowUserOrManager as { _id, role } (no .id),
    // so resolve both id shapes.
    const userId = req.user.id || req.user._id;
    const isSuperAdmin =
      req.isSuperAdmin === true ||
      String(req.user?.role || "").toLowerCase() === "superadmin";

    const post = await Post.findById(postId);
    if (!post) {
      return res.status(404).json({ message: "Post not found" });
    }

    // The post owner, or a SuperAdmin (platform moderation), may delete a post.
    if (post.user.toString() !== String(userId) && !isSuperAdmin) {
      return res.status(403).json({ message: "Unauthorized to delete this post" });
    }

    // Deliberately NOT touching PlayerHistory (or its copied image paths): the
    // match stays on the author's and tagged players' timelines after the post
    // is gone. The unlink from the post is harmless — history never requires it.
    await Post.findByIdAndDelete(postId);
    res.json({ success: true, message: "Post deleted successfully" });
  } catch (error) {
    console.error("Error deleting post:", error);
    res.status(500).json({ message: error.message });
  }
};
