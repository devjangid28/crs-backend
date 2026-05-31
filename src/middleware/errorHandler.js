const errorHandler = (err, req, res, next) => {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);

  if (err.code === '23505') {
    return res.status(409).json({
      success: false,
      message: 'Duplicate entry. Record already exists.',
      error: err.message,
    });
  }

  if (err.code === '23503') {
    return res.status(400).json({
      success: false,
      message: 'Referenced record not found.',
      error: err.message,
    });
  }

  res.status(err.status || 500).json({
    success: false,
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
};

module.exports = errorHandler;
