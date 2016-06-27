'use strict';
var express = require('express');
// eslint-disable-next-line new-cap
var router = express.Router();
var multer  = require('multer');
var fs = require('fs');
var extend = require('extend');
var path = require('path');
var async = require('async');
var validator = require('validator');
var watson = require('watson-developer-cloud');
var uuid = require('uuid');
var bundleUtils = require('../config/bundle-utils');
var os = require('os');

var ONE_HOUR = 3600000;

// Create the service wrapper
var visualRecognition = watson.visual_recognition({
  version: 'v3',
  api_key: process.env.API_KEY || '<api-key>',
  version_date: '2015-05-19'
});

// Setup the upload mechanism
var storage = multer.diskStorage({
  destination: function(req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

var upload = multer({
  storage: storage
});
router.upload = upload;

var scoreData = function(score) {
  var scoreColor;
  if (score >= 0.8) {
    scoreColor = '#b9e7c9';
  } else if (score >= 0.6) {
    scoreColor = '#f5d5bb';
  } else {
    scoreColor = '#f4bac0';
  }
  return { score: score, xloc: (score * 312.0), scoreColor: scoreColor};
};

router.get('/thermometer', function(req, res) {
  if (typeof req.query.score === 'undefined') {
    return res.status(400).json({ error: 'Missing required parameter: score', code: 400 });
  }

  let score = parseFloat(req.query.score);
  if (score >= 0.0 && score <= 1.0) {
    res.set('Content-type', 'image/svg+xml');
    res.render('thermometer', scoreData(score));
  } else {
    return res.status(400).json({ error: 'Score value invalid', code: 400 });
  }
});


function deleteUploadedFile(readStream) {
  fs.unlink(readStream.path, function(e) {
    if (e) {
      console.log('error deleting %s: %s', readStream.path, e);
    }
  });
}

/**
 * Creates a classifier
 * @param req.body.bundles Array of selected bundles
 * @param req.body.kind The bundle kind
 */
router.post('/classifiers', router.upload.fields([{ name: 'classupload', maxCount: 3 }, { name: 'negativeclassupload', maxCount: 1 }]), function(req, res) {
  var formData;

  if (!req.files) {
    formData = bundleUtils.createFormData(req.body);
  } else {
    formData = { name: req.body.classifiername };
    req.files.classupload.map(function(fileobj, idx) {
      formData[req.body.classname[idx] + '_positive_examples'] = fs.createReadStream(path.join(fileobj.destination, fileobj.filename));
    });

    if (req.files.negativeclassupload && req.files.negativeclassupload.length > 0) {
      var negpath = path.join(req.files.negativeclassupload[0].destination, req.files.negativeclassupload[0].filename);
      formData.negative_examples = fs.createReadStream(negpath);
    }
  }

  visualRecognition.createClassifier(formData, function createClassifier(err, classifier) {
    if (req.files) {
      req.files.classupload.map(deleteUploadedFile);
      if (req.files.negativeclassupload) {
        req.files.negativeclassupload.map(deleteUploadedFile);
      }
    }

    if (err) {
      console.log(err);
      return res.status(err.code || 500).json(err);
    }
    // deletes the classifier after an hour
    setTimeout(visualRecognition.deleteClassifier.bind(visualRecognition, classifier), ONE_HOUR);
    res.json(classifier);
  });
});

/**
 * Gets the status of a classifier
 * @param req.params.classifier_id The classifier id
 */
router.get('/classifiers/:classifier_id', function(req, res) {
  visualRecognition.getClassifier(req.params, function getClassifier(err, classifier) {
    if (err) {
      console.log(err);
      return res.status(err.code || 500).json(err);
    }
    res.json(classifier);
  });});

/**
 * Parse a base 64 image and return the extension and buffer
 * @param  {String} imageString The image data as base65 string
 * @return {Object}             { type: String, data: Buffer }
 */
function parseBase64Image(imageString) {
  var matches = imageString.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
  var resource = {};

  if (matches.length !== 3) {
    return null;
  }

  resource.type = matches[1] === 'jpeg' ? 'jpg' : matches[1];
  resource.data = new Buffer(matches[2], 'base64');
  return resource;
}

/**
 * Classifies an image
 * @param req.body.url The URL for an image either.
 *                     images/test.jpg or https://example.com/test.jpg
 * @param req.file The image file.
 */
router.post('/classify', router.upload.single('images_file'), function(req, res) {
  var params = {
    url: null,
    images_file: null
  };

  if (req.file) { // file image
    params.images_file = fs.createReadStream(req.file.path);
  } else if (req.body.url && req.body.url.indexOf('images') === 0) { // local image
    params.images_file = fs.createReadStream(path.join('public', req.body.url));
  } else if (req.body.image_data) {
    // write the base64 image to a temp file
    var resource = parseBase64Image(req.body.image_data);
    var temp = path.join(os.tmpdir(), uuid.v1() + '.' + resource.type);
    fs.writeFileSync(temp, resource.data);
    params.images_file = fs.createReadStream(temp);
  } else if (req.body.url && validator.isURL(req.body.url)) { // url
    params.url = req.body.url;
  } else { // malformed url
    return res.status(400).json({ error: 'Malformed URL', code: 400 });
  }

  if (params.images_file) {
    delete params.url;
  } else {
    delete params.images_file;
  }
  var methods = [];
  if (req.body.classifier_id) {
    params.classifier_ids = [req.body.classifier_id];
    methods.push('classify');
  } else {
    methods.push('classify');
    methods.push('detectFaces');
    methods.push('recognizeText');
  }

  // run the 3 classifiers asynchronously and combine the results
  async.parallel(methods.map(function(method) {
    return async.reflect(visualRecognition[method].bind(visualRecognition, params));
  }), function(err, results) {
    // delete the recognized file
    if (params.images_file && !req.body.url) {
      deleteUploadedFile(params.images_file);
    }

    if (err) {
      console.log(err);
      return res.status(err.code || 500).json(err);
    }
    // combine the results
    var combine = results.map(function(result) {
      if (result.value && result.value.length) {
        // value is an array of arguments passed to the callback (excluding the error).
        // In this case, it's the result and then the request object.
        // We only want the result.
        result.value = result.value[0];
      }
      return result;
    }).reduce(function(prev, cur) {
      return extend(true, prev, cur);
    });
    if (combine.value) {
      // save the classifier_id as part of the response
      if (req.body.classifier_id) {
        combine.value.classifier_ids = req.body.classifier_id;
      }
      combine.value.raw = {};
      methods.map(function(methodName, idx) {
        combine.value.raw[methodName] = encodeURIComponent(JSON.stringify(results[idx].value));
      });
      res.json(combine.value);
    } else {
      res.status(400).json(combine.error);
    }
  });
});

module.exports = router;