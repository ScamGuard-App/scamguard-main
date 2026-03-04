import supabase, { ensureSupabase } from './supabase.js';

// grab DOM elements once the document is ready
const reportForm = document.getElementById('reportForm');
const successMessage = document.getElementById('successMessage');
const errorMessage = document.getElementById('errorMessage');
const errorText = document.getElementById('errorText');
const evidenceInput = document.getElementById('evidenceInput');
const evidenceArea = document.getElementById('evidenceArea');
const evidenceList = document.getElementById('evidenceList');
let uploadedFiles = [];

// helper utilities
function showError(msg) {
    errorText.textContent = msg;
    errorMessage.style.display = 'block';
}

function clearMessages() {
    successMessage.style.display = 'none';
    errorMessage.style.display = 'none';
}

// --- evidence file handling ---
if (evidenceInput) {
    evidenceInput.addEventListener('change', (e) => handleEvidenceFiles(e.target.files));
}

if (evidenceArea) {
    evidenceArea.addEventListener('dragover', (e) => { e.preventDefault(); evidenceArea.classList.add('dragover'); });
    evidenceArea.addEventListener('dragleave', () => { evidenceArea.classList.remove('dragover'); });
    evidenceArea.addEventListener('drop', (e) => { e.preventDefault(); evidenceArea.classList.remove('dragover'); handleEvidenceFiles(e.dataTransfer.files); });
}

function handleEvidenceFiles(files) {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/gif', 'application/pdf'];
    for (let file of files) {
        if (!allowedTypes.includes(file.type)) {
            showError('Invalid file type. Only PNG/JPG/GIF/PDF allowed.');
            continue;
        }
        if (file.size > 10 * 1024 * 1024) {
            showError('Each file must be 10MB or smaller.');
            continue;
        }
        if (!uploadedFiles.some(f => f.name === file.name && f.size === file.size)) {
            uploadedFiles.push(file);
        }
    }
    updateEvidenceList();
}

function updateEvidenceList() {
    if (!evidenceList) return;
    evidenceList.innerHTML = '';
    uploadedFiles.forEach((file, i) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        const icon = file.type.startsWith('image/') ? 'fa-image' : 'fa-file-pdf';
        item.innerHTML = `
            <div class="file-name"><i class="fas ${icon}"></i> <span>${file.name} (${(file.size/1024).toFixed(0)} KB)</span></div>
            <button type="button" class="remove-btn" data-index="${i}">Remove</button>
        `;
        evidenceList.appendChild(item);
    });
}

document.addEventListener('click', (e) => {
    if (e.target.matches('#evidenceList .remove-btn') || e.target.matches('.remove-btn')) {
        const idx = parseInt(e.target.getAttribute('data-index'), 10);
        if (!isNaN(idx)) {
            uploadedFiles.splice(idx, 1);
            updateEvidenceList();
        }
    }
});

function makeId() { return Math.random().toString(36).substr(2,9); }

reportForm.addEventListener('submit', async e => {
    e.preventDefault();
    clearMessages();

    const sb = await ensureSupabase();
    if (!sb) {
        showError('Service unavailable');
        return;
    }

    // make sure a user is logged in
    const { data: { session } } = await sb.auth.getSession();
    if (!session || !session.user) {
        showError('You must be logged in to submit a report.');
        return;
    }

    let phoneVal = document.getElementById('phone').value || '';
    // strip non-digits, convert to number if possible
    phoneVal = phoneVal.replace(/\D/g, '');
    const payload = {
        user_id: session.user.id,
        phone: phoneVal ? parseInt(phoneVal, 10) : null,
        title: document.getElementById('title').value,
        scammer_name: document.getElementById('scammerName')?.value || null,
        type: document.getElementById('type').value,
        desc: document.getElementById('description').value,
        evidence_url: null // will be set after uploading files
    };

    try {
        // upload evidence files to the 'evidence' bucket but first verify magic numbers
        const evidencePaths = [];
        if (uploadedFiles.length > 0) {
            for (let file of uploadedFiles) {
                // client-side magic number check
                const ok = await verifyMagicNumber(file);
                if (!ok) {
                    showError(`File ${file.name} appears to be invalid or mismatched type.`);
                    return;
                }

                const filePath = `${session.user.id}/${Date.now()}_${makeId()}_${file.name}`;
                const { data: uploadData, error: uploadError } = await sb
                    .storage
                    .from('evidence')
                    .upload(filePath, file);
                if (uploadError) throw uploadError;
                // store path (not public URL) and generate signed URLs when viewing
                if (uploadData && uploadData.path) evidencePaths.push(uploadData.path);
            }
            payload.evidence_url = JSON.stringify(evidencePaths);
        }

        const { data, error } = await sb
            .from('reports')
            .insert([payload]);

        if (error) throw error;

        successMessage.style.display = 'block';
        reportForm.reset();
        uploadedFiles = [];
        updateEvidenceList();

        successMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(() => (successMessage.style.display = 'none'), 5000);
    } catch (err) {
        console.error('submit error', err);
        showError('Unable to submit report. Please try again later.');
    }
});

// client-side magic number verifier for PNG, JPG, GIF, PDF
async function verifyMagicNumber(file) {
    try {
        const buf = await file.slice(0, 8).arrayBuffer();
        const bytes = new Uint8Array(buf);
        // PNG: 89 50 4E 47 0D 0A 1A 0A
        if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return true;
        // JPG: FF D8 FF
        if (bytes.length >= 3 && bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return true;
        // GIF: 'GIF'
        if (bytes.length >= 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return true;
        // PDF: '%PDF'
        if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return true;
        return false;
    } catch (e) {
        console.error('verifyMagicNumber error', e);
        return false;
    }
}
