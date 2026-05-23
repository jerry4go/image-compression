(function () {
  'use strict';

  const MAX_DIMENSION = 4096;
  const MIN_QUALITY = 0.72;
  const MAX_QUALITY = 0.92;
  const QUALITY_STEP = 0.04;

  const uploadZone = document.getElementById('uploadZone');
  const fileInput = document.getElementById('fileInput');
  const browseBtn = document.getElementById('browseBtn');
  const results = document.getElementById('results');
  const resultsList = document.getElementById('resultsList');
  const clearBtn = document.getElementById('clearBtn');
  const resultItemTemplate = document.getElementById('resultItemTemplate');

  const supportsWebP = checkWebPSupport();

  function checkWebPSupport() {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      return canvas.toDataURL('image/webp').startsWith('data:image/webp');
    } catch {
      return false;
    }
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

  function hasAlphaChannel(img) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.min(img.width, 64);
    canvas.height = Math.min(img.height, 64);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 4) {
      if (data[i] < 255) return true;
    }
    return false;
  }

  function getOutputFormat(file, img) {
    const type = file.type.toLowerCase();
    if (type === 'image/gif') {
      return { mime: 'image/jpeg', ext: 'jpg' };
    }
    if (type === 'image/png' && hasAlphaChannel(img)) {
      return { mime: 'image/png', ext: 'png' };
    }
    if (supportsWebP) {
      return { mime: 'image/webp', ext: 'webp' };
    }
    return { mime: 'image/jpeg', ext: 'jpg' };
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

  async function compressImage(file) {
    const img = await loadImageFromFile(file);
    const { mime, ext } = getOutputFormat(file, img);
    const canvas = drawToCanvas(img, mime);

    if (mime === 'image/png') {
      const blob = await canvasToBlob(canvas, mime);
      return { blob, ext, mime };
    }

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

    if (bestBlob.size >= file.size) {
      quality = MAX_QUALITY;
      while (quality >= MIN_QUALITY) {
        const blob = await canvasToBlob(canvas, mime, quality);
        if (blob.size < file.size) {
          bestBlob = blob;
          break;
        }
        quality -= QUALITY_STEP;
      }
    }

    return { blob: bestBlob, ext, mime };
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
    statusText.textContent = '正在压缩…';
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

  function updateResultSuccess(ctx, file, blob, ext) {
    const saved = calcSavedPercent(file.size, blob.size);
    ctx.sizeAfter.textContent = formatSize(blob.size);
    ctx.badge.hidden = false;

    if (saved > 0) {
      ctx.badge.textContent = `-${saved}%`;
      ctx.badge.classList.remove('size-badge--none');
    } else {
      ctx.badge.textContent = '已优化';
      ctx.badge.classList.add('size-badge--none');
    }

    ctx.statusText.textContent = saved > 0 ? '压缩完成' : '已是最佳大小';
    ctx.statusText.classList.remove('status-text--processing');

    const downloadUrl = URL.createObjectURL(blob);
    const baseName = file.name.replace(/\.[^.]+$/, '');
    const downloadName = `${baseName}_compressed.${ext}`;

    ctx.downloadBtn.disabled = false;
    ctx.downloadBtn.onclick = () => {
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = downloadName;
      a.click();
    };

    ctx.revokePreview();
    ctx.img.src = downloadUrl;
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
      const { blob, ext } = await compressImage(file);
      updateResultSuccess(ctx, file, blob, ext);
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
