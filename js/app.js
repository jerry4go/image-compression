(function () {
  'use strict';

  const MAX_DIMENSION = 4096;
  const MIN_QUALITY = 0.72;
  const MAX_QUALITY = 0.92;
  const PNG_COLOR_STEPS = [256, 224, 192, 160, 128, 96, 64, 0];
  const QUALITY_STEP = 0.04;

  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const results = document.getElementById('results');
  const resultsList = document.getElementById('resultsList');
  const clearBtn = document.getElementById('clearBtn');
  const resultItemTemplate = document.getElementById('resultItemTemplate');

  function getOutputFormat(file) {
    const type = file.type.toLowerCase();
    const extFromName = (file.name.match(/\.([^.]+)$/i) || [])[1]?.toLowerCase() || '';

    if (type === 'image/jpeg' || type === 'image/jpg' || extFromName === 'jpg' || extFromName === 'jpeg') {
      return { mime: 'image/jpeg', ext: extFromName === 'jpeg' ? 'jpeg' : 'jpg' };
    }
    if (type === 'image/png' || extFromName === 'png') {
      return { mime: 'image/png', ext: 'png' };
    }
    if (type === 'image/webp' || extFromName === 'webp') {
      return { mime: 'image/webp', ext: 'webp' };
    }
    if (type === 'image/gif' || extFromName === 'gif') {
      return { mime: 'image/gif', ext: 'gif' };
    }
    if (type === 'image/bmp' || extFromName === 'bmp') {
      return { mime: 'image/bmp', ext: 'bmp', passthrough: true };
    }

    return { mime: 'image/jpeg', ext: 'jpg' };
  }

  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function calcSavedPercent(original, compressed) {
    if (original === 0) return 0;
    return Math.round((1 - compressed / original) * 100);
  }

  function loadImageFromFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('无法读取图片'));
      };
      img.src = url;
    });
  }

  function pickBestResult(file, compressedBlob, ext, mime) {
    if (compressedBlob.size < file.size) {
      return { blob: compressedBlob, ext, mime, keptOriginal: false };
    }
    return { blob: file, ext, mime, keptOriginal: true };
  }

  function drawToCanvas(img, mime) {
    let { width, height } = img;
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
      const ratio = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
      width = Math.round(width * ratio);
      height = Math.round(height * ratio);
    }

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    if (mime !== 'image/png') {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
    }

    ctx.drawImage(img, 0, 0, width, height);
    return canvas;
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('压缩失败'))),
        mime,
        quality
      );
    });
  }

  async function getPngPixelFrames(file, img, canvas) {
    const w = canvas.width;
    const h = canvas.height;
    const resized = w !== img.naturalWidth || h !== img.naturalHeight;

    if (!resized && typeof UPNG !== 'undefined') {
      try {
        const buffer = await file.arrayBuffer();
        const decoded = UPNG.decode(buffer);
        return { frames: UPNG.toRGBA8(decoded), width: decoded.width, height: decoded.height };
      } catch {
        // fall through to canvas pixels
      }
    }

    const pixels = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    return {
      frames: [new Uint8Array(pixels).buffer],
      width: w,
      height: h,
    };
  }

  function encodePngWithColors(frames, width, height, colors) {
    const encoded = UPNG.encode(frames, width, height, colors);
    return new Blob([encoded], { type: 'image/png' });
  }

  async function compressPng(file, img, canvas) {
    if (typeof UPNG === 'undefined') {
      throw new Error('PNG 压缩库未加载');
    }

    const { frames, width, height } = await getPngPixelFrames(file, img, canvas);
    let bestBlob = null;

    for (const colors of PNG_COLOR_STEPS) {
      const blob = encodePngWithColors(frames, width, height, colors);
      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }
      if (blob.size < file.size * 0.85) break;
    }

    return pickBestResult(file, bestBlob, 'png', 'image/png');
  }

  const GIF_PRESETS = [
    { lossy: 40, colors: 256 },
    { lossy: 60, colors: 160 },
    { lossy: 80, colors: 128 },
    { lossless: true },
  ];

  let gifsicleModule = null;

  async function getGifsicle() {
    if (!gifsicleModule) {
      gifsicleModule = (await import('./lib/gifsicle.min.js')).default;
    }
    return gifsicleModule;
  }

  async function runGifsiclePreset(file, preset) {
    const gifsicle = await getGifsicle();
    const buffer = await file.arrayBuffer();
    const command = preset.lossless
      ? '-O1 --no-warnings 1.gif -o /out/out.gif'
      : `-O1 --lossy=${preset.lossy} --colors ${preset.colors} --no-warnings 1.gif -o /out/out.gif`;

    const result = await gifsicle.run({
      input: [{ file: buffer, name: '1.gif' }],
      command: [command],
    });

    if (!result || !result.length) {
      throw new Error('GIF 压缩失败');
    }
    return result[0];
  }

  async function compressGif(file) {
    let bestBlob = null;

    for (const preset of GIF_PRESETS) {
      const outFile = await runGifsiclePreset(file, preset);
      if (!bestBlob || outFile.size < bestBlob.size) {
        bestBlob = outFile;
      }
      if (outFile.size < file.size * 0.85) break;
    }

    if (!bestBlob) {
      return { blob: file, ext: 'gif', mime: 'image/gif', keptOriginal: true };
    }

    return pickBestResult(file, bestBlob, 'gif', 'image/gif');
  }

  async function compressLossy(file, canvas, mime, ext) {
    let bestBlob = null;
    let quality = MAX_QUALITY;

    while (quality >= MIN_QUALITY) {
      const blob = await canvasToBlob(canvas, mime, quality);
      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }
      if (blob.size < file.size * 0.85) break;
      quality -= QUALITY_STEP;
    }

    return pickBestResult(file, bestBlob, ext, mime);
  }

  async function compressImage(file) {
    const format = getOutputFormat(file);

    if (format.passthrough) {
      return { blob: file, ext: format.ext, mime: format.mime, keptOriginal: true };
    }

    if (format.mime === 'image/gif') {
      return compressGif(file);
    }

    const img = await loadImageFromFile(file);
    const { mime, ext } = format;
    const canvas = drawToCanvas(img, mime);

    if (mime === 'image/png') {
      return compressPng(file, img, canvas);
    }

    return compressLossy(file, canvas, mime, ext);
  }

  function createResultItem(file) {
    const node = resultItemTemplate.content.cloneNode(true);
    const img = node.querySelector('.result-item__img');
    const name = node.querySelector('.result-item__name');
    const sizeBefore = node.querySelector('.size--before');
    const sizeAfter = node.querySelector('.size--after');
    const badge = node.querySelector('.size-badge');
    const statusText = node.querySelector('.status-text');
    const downloadBtn = node.querySelector('.btn--download');

    name.textContent = file.name;
    sizeBefore.textContent = formatSize(file.size);
    sizeAfter.textContent = '—';
    badge.hidden = true;
    statusText.textContent = file.type === 'image/gif' || /\.gif$/i.test(file.name)
      ? 'GIF 压缩中，请稍候…'
      : '正在压缩…';
    statusText.classList.add('status-text--processing');

    const previewUrl = URL.createObjectURL(file);
    img.src = previewUrl;

    resultsList.appendChild(node);
    results.hidden = false;

    return {
      img,
      sizeAfter,
      badge,
      statusText,
      downloadBtn,
      revokePreview() {
        URL.revokeObjectURL(previewUrl);
      },
    };
  }

  function updateResultSuccess(ctx, file, result) {
    const { blob, ext, keptOriginal } = result;
    const saved = calcSavedPercent(file.size, blob.size);
    ctx.sizeAfter.textContent = formatSize(blob.size);
    ctx.badge.hidden = false;

    if (saved > 0) {
      ctx.badge.textContent = `-${saved}%`;
      ctx.badge.classList.remove('size-badge--none');
    } else {
      ctx.badge.textContent = '原图';
      ctx.badge.classList.add('size-badge--none');
    }

    if (saved > 0) {
      ctx.statusText.textContent = '压缩完成';
    } else if (keptOriginal) {
      ctx.statusText.textContent = '原图已是最优，已保留原图';
    } else {
      ctx.statusText.textContent = '已是最佳大小';
    }
    ctx.statusText.classList.remove('status-text--processing');

    const baseName = file.name.replace(/\.[^.]+$/, '');
    const downloadName = keptOriginal ? file.name : `${baseName}_compressed.${ext}`;

    ctx.downloadBtn.disabled = false;
    ctx.downloadBtn.onclick = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = downloadName;
      a.click();
      URL.revokeObjectURL(url);
    };

    if (!keptOriginal) {
      const previewUrl = URL.createObjectURL(blob);
      ctx.revokePreview();
      ctx.img.src = previewUrl;
    }
  }

  function updateResultError(ctx, message) {
    ctx.statusText.textContent = message;
    ctx.statusText.classList.remove('status-text--processing');
    ctx.statusText.classList.add('status-text--error');
    ctx.downloadBtn.disabled = true;
  }

  async function processFile(file) {
    if (!file.type.startsWith('image/')) return;

    const ctx = createResultItem(file);

    try {
      const result = await compressImage(file);
      updateResultSuccess(ctx, file, result);
    } catch (err) {
      updateResultError(ctx, err.message || '压缩失败');
    }
  }

  function handleFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith('image/'));
    files.forEach(processFile);
  }

  uploadZone.addEventListener('click', (e) => {
    if (e.target === browseBtn || browseBtn.contains(e.target)) return;
    fileInput.click();
  });

  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    fileInput.click();
  });

  fileInput.addEventListener('change', () => {
    handleFiles(fileInput.files);
    fileInput.value = '';
  });

  uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('upload-zone--dragover');
  });

  uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('upload-zone--dragover');
  });

  uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('upload-zone--dragover');
    handleFiles(e.dataTransfer.files);
  });

  clearBtn.addEventListener('click', () => {
    resultsList.innerHTML = '';
    results.hidden = true;
  });
})();
