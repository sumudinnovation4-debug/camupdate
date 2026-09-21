// Shared Cloudinary unsigned-upload helper.
// Cloud name + upload preset are safe to expose client-side (that's the point of an
// unsigned preset). The API key/secret must NEVER go in browser code.
//
// Previously this lived only inside auth.html, so create.html, yard.html and
// profile.html called window.CP.uploadToCloudinary and got
// "is not a function" — which is why posting a listing or a feed post with a photo failed.
window.CP = window.CP || {};
window.CP.CLOUDINARY_CLOUD_NAME = window.CP.CLOUDINARY_CLOUD_NAME || 'dkkowi2j9';
window.CP.CLOUDINARY_UPLOAD_PRESET = window.CP.CLOUDINARY_UPLOAD_PRESET || 'campusplug';

/** Uploads one image to Cloudinary and resolves with its secure_url. onProgress(percent) is optional. */
window.CP.uploadToCloudinary = function (file, { folder = 'camplugie/listings', onProgress } = {}) {
  return new Promise((resolve, reject) => {
    if (!file) { resolve(null); return; }
    if (!file.type?.startsWith('image/')) { reject(new Error('Please select an image file.')); return; }
    if (file.size > 8 * 1024 * 1024) { reject(new Error('Image must be under 8MB.')); return; }

    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', window.CP.CLOUDINARY_UPLOAD_PRESET);
    if (folder) formData.append('folder', folder);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `https://api.cloudinary.com/v1_1/${window.CP.CLOUDINARY_CLOUD_NAME}/image/upload`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onload = () => {
      let payload = {};
      try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
      console.log('Cloudinary upload response:', xhr.status, payload);
      if (xhr.status >= 200 && xhr.status < 300 && payload.secure_url) { resolve(payload.secure_url); return; }
      const cloudinaryMsg = payload?.error?.message;
      reject(new Error(
        cloudinaryMsg
          ? `Cloudinary: ${cloudinaryMsg}`
          : `Upload failed (HTTP ${xhr.status}). Most likely cause: the "${window.CP.CLOUDINARY_UPLOAD_PRESET}" upload preset in your Cloudinary dashboard doesn't exist or isn't set to "Unsigned" mode (Settings → Upload → Upload presets).`
      ));
    };
    xhr.onerror = () => reject(new Error('Network upload failed \u2014 couldn\u2019t reach Cloudinary at all. Check your internet connection.'));
    xhr.send(formData);
  });
};

/** Uploads several images in parallel; resolves with an array of secure_urls in the same order. */
window.CP.uploadMultipleToCloudinary = function (files, opts) {
  return Promise.all(Array.from(files).map(f => window.CP.uploadToCloudinary(f, opts)));
};
