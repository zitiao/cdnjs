/* pica 1.0.3 nodeca/pica */!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.pica=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({"./":[function(require,module,exports){
'use strict';

/*global window:true*/
/*eslint space-infix-ops:0*/

// Feature detect
var WORKER = (typeof window !== 'undefined') && ('Worker' in window);
if (WORKER) {
  // IE don't allow to create webworkers from string. We should check it.
  // https://connect.microsoft.com/IE/feedback/details/801810/web-workers-from-blob-urls-in-ie-10-and-11
  try {
    var wkr = require('webworkify')(function () {});
    wkr.terminate();
  } catch (__) {
    WORKER = false;
  }
}

var resize       = require('./lib/resize');
var resizeWorker = require('./lib/resize_worker');


////////////////////////////////////////////////////////////////////////////////
// Helpers
function _class(obj) { return Object.prototype.toString.call(obj); }
function isFunction(obj) { return _class(obj) === '[object Function]'; }


////////////////////////////////////////////////////////////////////////////////
// API methods


// RGBA buffer async resize
//
function resizeBuffer(options, callback) {
  var wr;

  var _opts = {
    src:      options.src,
    dest:     options.dest,
    width:    options.width|0,
    height:   options.height|0,
    toWidth:  options.toWidth|0,
    toHeight: options.toHeight|0,
    quality:  options.quality,
    alpha:    options.alpha,
    unsharpAmount:    options.unsharpAmount,
    unsharpThreshold: options.unsharpThreshold
  };

  if (WORKER && exports.WW) {
    wr = require('webworkify')(resizeWorker);

    wr.onmessage = function(ev) {
      var i, l,
          dest = options.dest,
          output = ev.data.output;

      // If we got output buffer by reference, we should copy data,
      // because WW returns independent instance
      if (dest) {
        // IE ImageData can return old-style CanvasPixelArray
        // without .set() method. Copy manually for such case.
        if (dest.set) {
          dest.set(output);
        } else {
          for (i = 0, l = output.length; i < l; i++) {
            dest[i] = output[i];
          }
        }
      }
      callback(ev.data.err, output);
      wr.terminate();
    };

    wr.postMessage(_opts);

  } else {
    resize(_opts, callback);
  }
}


// Canvas async resize
//
function resizeCanvas(from, to, options, callback) {
  var w = from.width,
      h = from.height,
      w2 = to.width,
      h2 = to.height;

  if (isFunction(options)) {
    callback = options;
    options = {};
  }

  if (!isNaN(options)) {
    options = { quality: options, alpha: false };
  }

  var ctxTo = to.getContext('2d');
  var imageDataTo = ctxTo.getImageData(0, 0, w2, h2);

  var _opts = {
    src:      from.getContext('2d').getImageData(0, 0, w, h).data,
    dest:     imageDataTo.data,
    width:    from.width,
    height:   from.height,
    toWidth:  to.width,
    toHeight: to.height,
    quality:  options.quality,
    alpha:    options.alpha,
    unsharpAmount:    options.unsharpAmount,
    unsharpThreshold: options.unsharpThreshold
  };

  resizeBuffer(_opts, function (err/*, output*/) {
    if (err) {
      callback(err);
      return;
    }

    ctxTo.putImageData(imageDataTo, 0, 0);
    callback();
  });
}


exports.resizeBuffer = resizeBuffer;
exports.resizeCanvas = resizeCanvas;
exports.WW = WORKER;

},{"./lib/resize":3,"./lib/resize_worker":4,"webworkify":5}],1:[function(require,module,exports){
// High speed resize with tuneable speed/quality ratio

'use strict';


var unsharp = require('./unsharp');


// Precision of fixed FP values
var FIXED_FRAC_BITS = 14;
var FIXED_FRAC_VAL  = 1 << FIXED_FRAC_BITS;


//
// Presets for quality 0..3. Filter functions + window size
//
var FILTER_INFO = [
  { // Nearest neibor (Box)
    win: 0.5,
    filter: function (x) {
      return (x >= -0.5 && x < 0.5) ? 1.0 : 0.0;
    }
  },
  { // Hamming
    win: 1.0,
    filter: function (x) {
      if (x <= -1.0 || x >= 1.0) { return 0.0; }
      if (x > -1.19209290E-07 && x < 1.19209290E-07) { return 1.0; }
      var xpi = x * Math.PI;
      return ((Math.sin(xpi) / xpi) *  (0.54 + 0.46 * Math.cos(xpi / 1.0)));
    }
  },
  { // Lanczos, win = 2
    win: 2.0,
    filter: function (x) {
      if (x <= -2.0 || x >= 2.0) { return 0.0; }
      if (x > -1.19209290E-07 && x < 1.19209290E-07) { return 1.0; }
      var xpi = x * Math.PI;
      return (Math.sin(xpi) / xpi) * Math.sin(xpi / 2.0) / (xpi / 2.0);
    }
  },
  { // Lanczos, win = 3
    win: 3.0,
    filter: function (x) {
      if (x <= -3.0 || x >= 3.0) { return 0.0; }
      if (x > -1.19209290E-07 && x < 1.19209290E-07) { return 1.0; }
      var xpi = x * Math.PI;
      return (Math.sin(xpi) / xpi) * Math.sin(xpi / 3.0) / (xpi / 3.0);
    }
  }
];

function clampTo8(i) { return i < 0 ? 0 : (i > 255 ? 255 : i); }

function toFixedPoint(num) { return Math.floor(num * FIXED_FRAC_VAL); }


// Calculate convolution filters for each destination point,
// and pack data to Int16Array:
//
// [ shift, length, data..., shift2, length2, data..., ... ]
//
// - shift - offset in src image
// - length - filter length (in src points)
// - data - filter values sequence
//
function createFilters(quality, srcSize, destSize) {

  var filterFunction = FILTER_INFO[quality].filter;

  var scale         = destSize / srcSize;
  var scaleInverted = 1.0 / scale;
  var scaleClamped  = Math.min(1.0, scale); // For upscale

  // Filter window (averaging interval), scaled to src image
  var srcWindow = FILTER_INFO[quality].win / scaleClamped;

  var destPixel, srcPixel, srcFirst, srcLast, filterElementSize,
      floatFilter, fxpFilter, total, fixedTotal, pxl, idx, floatVal, fixedVal;
  var leftNotEmpty, rightNotEmpty, filterShift, filterSize;

  var maxFilterElementSize = Math.floor((srcWindow + 1) * 2 );
  var packedFilter    = new Int16Array((maxFilterElementSize + 2) * destSize);
  var packedFilterPtr = 0;

  // For each destination pixel calculate source range and built filter values
  for (destPixel = 0; destPixel < destSize; destPixel++) {

    // Scaling should be done relative to central pixel point
    srcPixel = (destPixel + 0.5) * scaleInverted;

    srcFirst = Math.max(0, Math.floor(srcPixel - srcWindow));
    srcLast  = Math.min(srcSize - 1, Math.ceil(srcPixel + srcWindow));

    filterElementSize = srcLast - srcFirst + 1;
    floatFilter = new Float32Array(filterElementSize);
    fxpFilter = new Int16Array(filterElementSize);

    total = 0.0;

    // Fill filter values for calculated range
    for (pxl = srcFirst, idx = 0; pxl <= srcLast; pxl++, idx++) {
      floatVal = filterFunction(((pxl + 0.5) - srcPixel) * scaleClamped);
      total += floatVal;
      floatFilter[idx] = floatVal;
    }

    // Normalize filter, convert to fixed point and accumulate conversion error
    fixedTotal = 0;

    for (idx = 0; idx < floatFilter.length; idx++) {
      fixedVal = toFixedPoint(floatFilter[idx] / total);
      fixedTotal += fixedVal;
      fxpFilter[idx] = fixedVal;
    }

    // Compensate normalization error, to minimize brightness drift
    fxpFilter[destSize >> 1] += toFixedPoint(1.0) - fixedTotal;

    //
    // Now pack filter to useable form
    //
    // 1. Trim heading and tailing zero values, and compensate shitf/length
    // 2. Put all to single array in this format:
    //
    //    [ pos shift, data length, value1, value2, value3, ... ]
    //

    leftNotEmpty = 0;
    while (leftNotEmpty < fxpFilter.length && fxpFilter[leftNotEmpty] === 0) {
      leftNotEmpty++;
    }

    if (leftNotEmpty < fxpFilter.length) {
      rightNotEmpty = fxpFilter.length - 1;
      while (rightNotEmpty > 0 && fxpFilter[rightNotEmpty] === 0) {
        rightNotEmpty--;
      }

      filterShift = srcFirst + leftNotEmpty;
      filterSize = rightNotEmpty - leftNotEmpty + 1;

      packedFilter[packedFilterPtr++] = filterShift; // shift
      packedFilter[packedFilterPtr++] = filterSize; // size

      packedFilter.set(fxpFilter.subarray(leftNotEmpty, rightNotEmpty + 1), packedFilterPtr);
      packedFilterPtr += filterSize;
    } else {
      // zero data, write header only
      packedFilter[packedFilterPtr++] = 0; // shift
      packedFilter[packedFilterPtr++] = 0; // size
    }
  }
  return packedFilter;
}


function convolveHorizontally(src, dest, srcW, srcH, destW, destH, filters) {

  var r, g, b, a;
  var filterPtr, filterShift, filterSize;
  var srcPtr, srcY, destX, filterVal;
  var srcOffset = 0, destOffset = 0;

  // For each row
  for (srcY = 0; srcY < srcH; srcY++) {
    filterPtr  = 0;

    // Apply precomputed filters to each destination row point
    for (destX = 0; destX < destW; destX++) {
      // Get the filter that determines the current output pixel.
      filterShift     = filters[filterPtr++];
      filterSize      = filters[filterPtr++];

      srcPtr = (srcOffset + (filterShift * 4))|0;

      r = g = b = a = 0;

      // Apply the filter to the row to get the destination pixel r, g, b, a
      for (; filterSize > 0; filterSize--) {
        filterVal = filters[filterPtr++];

        // Use reverse order to workaround deopts in old v8 (node v.10)
        // Big thanks to @mraleph (Vyacheslav Egorov) for the tip.
        a = (a + filterVal * src[srcPtr + 3])|0;
        b = (b + filterVal * src[srcPtr + 2])|0;
        g = (g + filterVal * src[srcPtr + 1])|0;
        r = (r + filterVal * src[srcPtr])|0;
        srcPtr = (srcPtr + 4)|0;
      }

      // Bring this value back in range. All of the filter scaling factors
      // are in fixed point with FIXED_FRAC_BITS bits of fractional part.
      dest[destOffset++] = clampTo8((r|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((g|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((b|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((a|0) >> 14/*FIXED_FRAC_BITS*/);
    }

    srcOffset += srcW * 4;
  }
}


function convolveVertically(src, dest, srcW, srcH, destW, destH, filters, withAlpha) {
  var r, g, b, a;
  var filterPtr, filterShift, filterSize;
  var srcPtr, srcX, destY, filterVal;
  var srcOffset = 0, destOffset = 0;

  // For each row
  for (srcX = 0; srcX < destW; srcX++) {
    filterPtr  = 0;

    // Apply precomputed filters to each destination row point
    for (destY = 0; destY < destH; destY++) {
      // Get the filter that determines the current output pixel.
      filterShift     = filters[filterPtr++];
      filterSize      = filters[filterPtr++];

      srcPtr = (srcOffset + (filterShift * destW * 4))|0;

      r = g = b = a = 0;

      // Apply the filter to the row to get the destination pixel r, g, b, a
      for (; filterSize > 0; filterSize--) {
        filterVal = filters[filterPtr++];

        // Use reverse order to workaround deopts in old v8 (node v.10)
        // Big thanks to @mraleph (Vyacheslav Egorov) for the tip.
        if (withAlpha) { a = (a + filterVal * src[srcPtr + 3])|0; }
        b = (b + filterVal * src[srcPtr + 2])|0;
        g = (g + filterVal * src[srcPtr + 1])|0;
        r = (r + filterVal * src[srcPtr])|0;
        srcPtr = (srcPtr + destW * 4)|0;
      }

      // Bring this value back in range. All of the filter scaling factors
      // are in fixed point with FIXED_FRAC_BITS bits of fractional part.
      dest[destOffset++] = clampTo8((r|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((g|0) >> 14/*FIXED_FRAC_BITS*/);
      dest[destOffset++] = clampTo8((b|0) >> 14/*FIXED_FRAC_BITS*/);
      if (withAlpha) {
        // Fix alpha channel if become wrong due rounding errors.
        // It can't be smaller than any color channel.
        // Operate with unshifted values for simplicity
        if (a < r) { a = r; }
        if (a < g) { a = g; }
        if (a < b) { a = b; }

        dest[destOffset] = clampTo8((a|0) >> 14/*FIXED_FRAC_BITS*/);
      } else {
        dest[destOffset] = 0xff;
      }
      destOffset += destW * 4 - 3;
    }

    srcOffset += 4;
    destOffset = srcOffset;
  }
}


function resize(options) {
  var src   = options.src;
  var srcW  = options.width;
  var srcH  = options.height;
  var destW = options.toWidth;
  var destH = options.toHeight;
  var dest  = options.dest || new Uint8Array(destW * destH * 4);
  var quality = options.quality === undefined ? 3 : options.quality;
  var alpha = options.alpha || false;
  var unsharpAmount = options.unsharpAmount === undefined ? 0 : (options.unsharpAmount|0);
  var unsharpThreshold = options.unsharpThreshold === undefined ? 0 : (options.unsharpThreshold|0);

  if (srcW < 1 || srcH < 1 || destW < 1 || destH < 1) { return []; }

  var filtersX = createFilters(quality, srcW, destW),
      filtersY = createFilters(quality, srcH, destH);

  var tmp  = new Uint8Array(destW * srcH * 4);

  convolveHorizontally(src, tmp, srcW, srcH, destW, destH, filtersX);
  convolveVertically(tmp, dest, destW, srcH, destW, destH, filtersY, alpha);

  if (unsharpAmount) {
    unsharp(dest, destW, destH, unsharpAmount, 1.0, unsharpThreshold);
  }

  return dest;
}


module.exports = resize;

},{"./unsharp":2}],2:[function(require,module,exports){
// Unsharp mask filter
//
// http://stackoverflow.com/a/23322820/1031804
// USM(O) = O + (2 * (Amount / 100) * (O - GB))
// GB - gaussial blur.
//
// brightness = 0.299*R + 0.587*G + 0.114*B
// http://stackoverflow.com/a/596243/1031804
//
// To simplify math, normalize brighness mutipliers to 2^16:
//
// brightness = (19595*R + 38470*G + 7471*B) / 65536

'use strict';


function clampTo8(i) { return i < 0 ? 0 : (i > 255 ? 255 : i); }

// Convert image to greyscale, 32bits FP result (16.16)
//
function greyscale(src, srcW, srcH) {
  var size = srcW * srcH;
  var result = new Uint32Array(size); // We don't use sign, but that helps to JIT
  var i, srcPtr;

  for (i = 0, srcPtr = 0; i < size; i++) {
    result[i] = (src[srcPtr + 2] * 7471       // blue
               + src[srcPtr + 1] * 38470      // green
               + src[srcPtr] * 19595) >>> 8;  // red
    srcPtr = (srcPtr + 4)|0;
  }

  return result;
}

var _blurKernel = new Uint8Array([
  1, 2, 1,
  2, 4, 2,
  1, 2, 1
]);

var _bkWidth = Math.floor(Math.sqrt(_blurKernel.length));
var _bkHalf = Math.floor(_bkWidth / 2);
var _bkWsum = 0;
for (var wc=0; wc < _blurKernel.length; wc++) { _bkWsum += _blurKernel[wc]; }


function blur(gs, x, y, srcW, srcH) {
  var bx, by, sx, sy, w, wsum, br;
  var bPtr = 0;
  var blurKernel = _blurKernel;
  var bkHalf = _bkHalf;

  wsum = 0; // weight sum to normalize result
  br   = 0;

  if (x >= bkHalf && y >= bkHalf && x + bkHalf < srcW && y + bkHalf < srcH) {
    for (by = 0; by < 3; by++) {
      for (bx = 0; bx < 3; bx++) {
        sx = x + bx - bkHalf;
        sy = y + by - bkHalf;

        br += gs[sx + sy * srcW] * blurKernel[bPtr++];
      }
    }
    return (br - (br % _bkWsum)) / _bkWsum;
  }

  for (by = 0; by < 3; by++) {
    for (bx = 0; bx < 3; bx++) {
      sx = x + bx - bkHalf;
      sy = y + by - bkHalf;

      if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        w = blurKernel[bPtr];
        wsum += w;
        br += gs[sx + sy * srcW] * w;
      }
      bPtr++;
    }
  }
  return (br - (br % wsum)) / wsum;
}

// Apply unsharp mask to src
//
// NOTE: radius is ignored to simplify gaussian blur calculation
// on practice we need radius 0.3..2.0. Use 1.0 now.
//
function unsharp(src, srcW, srcH, amount, radius, threshold) {
  var x, y, c, diff = 0, corr, srcPtr;

  // Normalized delta multiplier. Expect that:
  var AMOUNT_NORM = Math.floor(amount * 256 / 50);

  // Convert to grayscale:
  //
  // - prevent color drift
  // - speedup blur calc
  //
  var gs = greyscale(src, srcW, srcH);
  var fpThreshold = threshold << 8;
  var gsPtr = 0;

  for (y = 0; y < srcH; y++) {
    for (x = 0; x < srcW; x++) {

      // calculate brightness blur, difference & update source buffer

      diff = (gs[gsPtr++] - blur(gs, x, y, srcW, srcH))|0;

      // Update source image if thresold exceeded
      if (Math.abs(diff) > fpThreshold) {
        // Calculate correction multiplier
        corr = 65536 + ((diff * AMOUNT_NORM) >> 8);
        srcPtr = (x + y * srcW) * 4;

        c = src[srcPtr];
        src[srcPtr++] = clampTo8((c * corr) >> 16);
        c = src[srcPtr];
        src[srcPtr++] = clampTo8((c * corr) >> 16);
        c = src[srcPtr];
        src[srcPtr] = clampTo8((c * corr) >> 16);
      }

    } // end row
  } // end column
}


module.exports = unsharp;

},{}],3:[function(require,module,exports){
// Proxy to simplify split between webworker/plain calls
'use strict';

var resize = require('./pure/resize');

module.exports = function (options, callback) {
  var output = resize(options);

  callback(null, output);
};

},{"./pure/resize":1}],4:[function(require,module,exports){
// Web Worker wrapper for image resize function

'use strict';

module.exports = function(self) {
  var resize = require('./resize');

  self.onmessage = function (ev) {
    resize(ev.data, function(err, output) {
      if (err) {
        self.postMessage({ err: err });
        return;
      }

      self.postMessage({ output: output });
    });
  };
};

},{"./resize":3}],5:[function(require,module,exports){
var bundleFn = arguments[3];
var sources = arguments[4];
var cache = arguments[5];

var stringify = JSON.stringify;

module.exports = function (fn) {
    var keys = [];
    var wkey;
    var cacheKeys = Object.keys(cache);
    
    for (var i = 0, l = cacheKeys.length; i < l; i++) {
        var key = cacheKeys[i];
        if (cache[key].exports === fn) {
            wkey = key;
            break;
        }
    }
    
    if (!wkey) {
        wkey = Math.floor(Math.pow(16, 8) * Math.random()).toString(16);
        var wcache = {};
        for (var i = 0, l = cacheKeys.length; i < l; i++) {
            var key = cacheKeys[i];
            wcache[key] = key;
        }
        sources[wkey] = [
            Function(['require','module','exports'], '(' + fn + ')(self)'),
            wcache
        ];
    }
    var skey = Math.floor(Math.pow(16, 8) * Math.random()).toString(16);
    
    var scache = {}; scache[wkey] = wkey;
    sources[skey] = [
        Function(['require'],'require(' + stringify(wkey) + ')(self)'),
        scache
    ];
    
    var src = '(' + bundleFn + ')({'
        + Object.keys(sources).map(function (key) {
            return stringify(key) + ':['
                + sources[key][0]
                + ',' + stringify(sources[key][1]) + ']'
            ;
        }).join(',')
        + '},{},[' + stringify(skey) + '])'
    ;
    return new Worker(window.URL.createObjectURL(
        new Blob([src], { type: 'text/javascript' })
    ));
};

},{}]},{},[])("./")
});