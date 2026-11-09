const express = require('express');
const router = express.Router();
const postController = require('../controllers/postController');
const { allowUserOrManager } = require('../middleware/authMiddleware');
const { uploadMiddleware } = require('../middleware/uploads');

// All authenticated write actions go through allowUserOrManager so Manager
// tokens (from /msocial in the dashboard) work the same as User tokens.
// Controllers use req.user.id for ownership and req.userRole === 'Manager'
// to set the polymorphic userModel on Post documents.
// Accepts JSON (as before) or multipart with up to 5 `postImages`.
router.post('/', allowUserOrManager, uploadMiddleware.array('postImages', 5), postController.createPost);
router.get('/', postController.getAllPosts);
router.post('/:postId/like', allowUserOrManager, postController.toggleLike);
router.post('/:postId/save', allowUserOrManager, postController.toggleSave);
router.get('/saved/:userId', postController.getSavedPostsByUser);
router.post('/:postId/comments', allowUserOrManager, postController.addComment);
router.delete('/:postId/comments/:commentId', allowUserOrManager, postController.deleteComment);
router.delete('/:postId', allowUserOrManager, postController.deletePost);
router.get("/:userId", postController.getPostsByUser);


module.exports = router;
