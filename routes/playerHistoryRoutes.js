const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/playerHistoryController');
const { allowUserOrManager } = require('../middleware/authMiddleware');
const { uploadMiddleware } = require('../middleware/uploads');

const images = uploadMiddleware.array('historyImages', 5);

// Static paths first so "pending" is never captured as an :id.
router.get('/pending', allowUserOrManager, ctrl.listPending);
router.get('/settings', allowUserOrManager, ctrl.getSettings);
router.put('/settings', allowUserOrManager, ctrl.updateSettings);
router.get('/user/:userId', allowUserOrManager, ctrl.listForUser);
router.post('/', allowUserOrManager, images, ctrl.create);
router.patch('/:id', allowUserOrManager, images, ctrl.update);
router.delete('/:id', allowUserOrManager, ctrl.remove);
router.post('/:id/approve', allowUserOrManager, ctrl.approve);
router.post('/:id/reject', allowUserOrManager, ctrl.reject);

module.exports = router;
