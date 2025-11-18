import express from 'express';
import path from 'path';
import { getAvatarsDir } from '../utils/avatar.js';

export const avatarsRouter = express.Router();

// Serve avatar images
avatarsRouter.get('/:filename', (req, res) => {
  const { filename } = req.params;

  // Validate filename to prevent directory traversal
  if (filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filepath = path.join(getAvatarsDir(), filename);

  // Set cache headers for better performance
  res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 1 day

  res.sendFile(filepath, (err) => {
    if (err) {
      console.error('Error serving avatar:', err);
      res.status(404).json({ error: 'Avatar not found' });
    }
  });
});
