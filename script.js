let subjectCount = 0;
const numScoreColumns = 8; // 1st-3rd Period, 1st Exam, 4th-6th Period, Final Exam
const columnIdMap = ['avg1', 'avg2', 'avg3', 'avgExam1', 'avg4', 'avg5', 'avg6', 'avgExam2'];
let currentThreshold = 70;
let activeColumns = []; // Tracks columns with data (indices)
let columnNames = ['1st Period', '2nd Period', '3rd Period', 'Exam 1', '4th Period', '5th Period', '6th Period', 'Final']; // For labeling
let lastOverallAvg = '0.00'; // For stats
let lastSubjectAvgs = []; // For stats
let currentUser = null; // Firebase user
let isGPAMode = false; // GPA toggle state

// NEW: Chart instances for visualizations
let subjectBarChart = null;
let gradePieChart = null;

// NEW: QR Scanning Variables
let videoStream = null;
let qrScanningInterval = null;

// REMOVED: Hardcoded OpenAI key - now handled via Vercel proxy (/api/openai)
// Ensure you have /api/openai.js deployed on Vercel with OPENAI_API_KEY env var

// NEW: Debounce utility for input events
function debounce(fn, delay) {
    let timeout;
    return function(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn.apply(this, args), delay);
    };
}

// UPDATED: Letter grade mapping (handles % and GPA)
function getLetterGrade(avg, isGPA = false) {
    const numAvg = parseFloat(avg);
    if (isGPA) {
        // GPA 4.0 scale mapping
        if (numAvg >= 3.7) return 'A';
        if (numAvg >= 3.3) return 'A-';
        if (numAvg >= 3.0) return 'B+';
        if (numAvg >= 2.7) return 'B';
        if (numAvg >= 2.3) return 'B-';
        if (numAvg >= 2.0) return 'C+';
        if (numAvg >= 1.7) return 'C';
        if (numAvg >= 1.3) return 'C-';
        if (numAvg >= 1.0) return 'D';
        return 'F';
    } else {
        // Percentage scale (original)
        if (numAvg >= 90) return 'A';
        if (numAvg >= 80) return 'B';
        if (numAvg >= 70) return 'C';
        if (numAvg >= 60) return 'D';
        return 'F';
    }
}

// UPDATED: GPA mapping (bucketed for accuracy)
function scaleToGPA(score) {
    const letter = getLetterGrade(score, false); // % to letter
    const gpaMap = { 
        'A': 4.0, 'A-': 3.7, 
        'B+': 3.3, 'B': 3.0, 'B-': 2.7, 
        'C+': 2.3, 'C': 2.0, 'C-': 1.7, 
        'D': 1.0, 'F': 0.0 
    };
    return gpaMap[letter] || 0.0;
}

// UPDATED: Retry last message (for AI errors) - now handles both chat types
let lastUserMessage = '';
function retryLastMessage(chatType = 'full') {  // Default to full chat
    if (lastUserMessage) {
        const input = chatType === 'floating' ? 
            document.getElementById('floatingChatInput') : 
            document.getElementById('aiChatInput');
        if (input) {
            input.value = lastUserMessage;
            if (chatType === 'floating') {
                sendMessageToFloatingAI();
            } else {
                sendMessageToAI();
            }
        }
    }
}

// UPDATED: AI Chat Functions (now proxies through Vercel /api/openai)
function handleKeyPress(e) {
    if (e.key === 'Enter') sendMessageToAI();
}

// NEW: Floating chat keypress handler
function handleFloatingKeyPress(e) {
    if (e.key === 'Enter') sendMessageToFloatingAI();
}

async function sendMessageToAI() {
    const input = document.getElementById('aiChatInput');
    const message = input.value.trim();
    if (!message) return;

    lastUserMessage = message; // For retry

    // Add user message to chat
    addMessageToChat(message, 'user');
    input.value = '';
    showAIStatus('🤔 Thinking...', 'loading');

    // NEW: Pass grades context for smarter replies
    const context = lastSubjectAvgs.length > 0 ? 
        `Current grades: Overall ${lastOverallAvg}%. Subjects: ${lastSubjectAvgs.map(s => `${s.name}: ${s.avg}%`).join('; ')}.` : 
        'No grades calculated yet.';

    try {
        const response = await fetch('/api/openai', {  // Vercel proxy endpoint
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful AI assistant for the Grade Calculator tool. Provide concise, friendly advice on grades, study tips, GPA calculation, or tool usage. Keep responses under 150 words. Be encouraging!'
                    },
                    { role: 'user', content: `${context} User query: ${message}` }
                ],
                max_tokens: 150,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('AI service not available—check deployment.');
            }
            const errorData = await response.json();
            throw new Error(errorData.error || `API Error ${response.status}`);
        }

        const data = await response.json();
        const aiReply = data.choices[0].message.content;
        addMessageToChat(aiReply, 'ai');
        showAIStatus('✅ Sent!', 'success');
    } catch (error) {
        console.error('AI Error:', error);
        const errorMsg = error.message.includes('not configured') ? '❌ API key not set on server. Contact admin.' :
                         error.message.includes('401') ? '❌ Invalid API key—check server config.' :
                         error.message.includes('429') ? '⏳ Rate limit hit. Try again in a minute.' :
                         '❌ Connection issue. Check internet or try again.';
        const fallbackMsg = 'AI is taking a break. Try: Focus on weak subjects for quick wins!';
        showAIStatus(errorMsg, 'error');
        addMessageToChat(`Sorry! ${errorMsg}. ${fallbackMsg} <button class="retry-btn" onclick="retryLastMessage()">Retry</button>`, 'ai');
    }
}

// UPDATED: Send message for floating chat (proxies through Vercel)
async function sendMessageToFloatingAI() {
    const input = document.getElementById('floatingChatInput');
    const message = input.value.trim();
    if (!message) return;

    lastUserMessage = message; // For retry

    // Add user message to floating chat
    addMessageToFloatingChat(message, 'user');
    input.value = '';
    showFloatingAIStatus('🤔 Thinking...', 'loading');

    // NEW: Pass grades context for smarter replies
    const context = lastSubjectAvgs.length > 0 ? 
        `Current grades: Overall ${lastOverallAvg}%. Subjects: ${lastSubjectAvgs.map(s => `${s.name}: ${s.avg}%`).join('; ')}.` : 
        'No grades calculated yet.';

    try {
        const response = await fetch('/api/openai', {  // Vercel proxy endpoint
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'gpt-3.5-turbo',
                messages: [
                    {
                        role: 'system',
                        content: 'You are a helpful AI assistant for the Grade Calculator tool. Provide concise, friendly advice on grades, study tips, GPA calculation, or tool usage. Keep responses under 150 words. Be encouraging!'
                    },
                    { role: 'user', content: `${context} User query: ${message}` }
                ],
                max_tokens: 150,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            if (response.status === 404) {
                throw new Error('AI service not available—check deployment.');
            }
            const errorData = await response.json();
            throw new Error(errorData.error || `API Error ${response.status}`);
        }

        const data = await response.json();
        const aiReply = data.choices[0].message.content;
        addMessageToFloatingChat(aiReply, 'ai');
        showFloatingAIStatus('✅ Sent!', 'success');
    } catch (error) {
        console.error('AI Error:', error);
        const errorMsg = error.message.includes('not configured') ? '❌ API key not set on server. Contact admin.' :
                         error.message.includes('401') ? '❌ Invalid API key—check server config.' :
                         error.message.includes('429') ? '⏳ Rate limit hit. Try again in a minute.' :
                         '❌ Connection issue. Check internet or try again.';
        const fallbackMsg = 'AI is taking a break. Try: Focus on weak subjects for quick wins!';
        showFloatingAIStatus(errorMsg, 'error');
        // UPDATED: Pass 'floating' to retry function
        addMessageToFloatingChat(`Sorry! ${errorMsg}. ${fallbackMsg} <button class="retry-btn" onclick="retryLastMessage('floating')">Retry</button>`, 'ai');
    }
}

function addMessageToChat(message, sender) {
    const messagesDiv = document.getElementById('aiChatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `ai-message ${sender}`;
    messageDiv.innerHTML = message;  // Use innerHTML for retry button
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// NEW: Add message to floating chat
function addMessageToFloatingChat(message, sender) {
    const messagesDiv = document.getElementById('floatingChatMessages');
    const messageDiv = document.createElement('div');
    messageDiv.className = `ai-message ${sender}`;
    messageDiv.innerHTML = message;  // Use innerHTML for retry button
    messagesDiv.appendChild(messageDiv);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function showAIStatus(message, type) {
    const statusDiv = document.getElementById('aiStatus');
    statusDiv.textContent = message;
    statusDiv.className = `ai-status ${type}`;
    if (type !== 'loading') {
        setTimeout(() => { statusDiv.textContent = ''; statusDiv.className = 'ai-status'; }, 3000);
    }
}

// NEW: Show status for floating chat
function showFloatingAIStatus(message, type) {
    const statusDiv = document.getElementById('floatingChatStatus');
    statusDiv.textContent = message;
    statusDiv.className = `floating-chat-status ${type}`;
    if (type !== 'loading') {
        setTimeout(() => { statusDiv.textContent = ''; statusDiv.className = 'floating-chat-status'; }, 3000);
    }
}

// NEW: Toggle floating chat window
function toggleFloatingChat() {
    const window = document.getElementById('floatingChatWindow');
    window.classList.toggle('active');
    if (window.classList.contains('active')) {
        document.getElementById('floatingChatInput').focus();
    }
}

// NEW: Close floating chat on outside click or Escape
document.addEventListener('click', function(e) {
    const window = document.getElementById('floatingChatWindow');
    const toggleBtn = document.querySelector('.floating-chat-toggle');
    if (window.classList.contains('active') && !window.contains(e.target) && !toggleBtn.contains(e.target)) {
        window.classList.remove('active');
    }
});

document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape') {
        const window = document.getElementById('floatingChatWindow');
        if (window.classList.contains('active')) {
            window.classList.remove('active');
        }
    }
});

// NEW: QR Scan Functions
function startQRScan() {
    const modal = document.getElementById('qrModal');
    const status = document.getElementById('qrStatus');
    modal.style.display = 'block';
    status.textContent = 'Requesting camera access...';

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
            videoStream = stream;
            const video = document.getElementById('qrVideo');
            video.srcObject = stream;
            video.play();
            status.textContent = 'Scanning for QR code...';
            startScanning(video);
        })
        .catch(err => {
            console.error('Camera Error:', err);
            status.textContent = 'Camera access denied. Please enable permissions.';
        });
}

function startScanning(video) {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    qrScanningInterval = setInterval(() => {
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = jsQR(imageData.data, imageData.width, imageData.height);
            if (code) {
                clearInterval(qrScanningInterval);
                handleQRScan(code.data);
            }
        }
    }, 500); // Scan every 500ms
}

function handleQRScan(data) {
    try {
        const session = JSON.parse(data);
        if (session && session.data && session.timestamp) {
            if (confirm(`Load session from ${session.timestamp}? This will overwrite current data.`)) {
                // Load like manual session
                document.querySelector('#gradeTable tbody').innerHTML = '';
                session.data.forEach(item => {
                    addSubjectRow(item.subject);
                    const inputs = document.querySelectorAll('#gradeTable tbody tr:last-child input[type="number"]');
                    item.scores.forEach((score, i) => {
                        if (inputs[i]) inputs[i].value = score;
                    });
                });
                setTimeout(() => {
                    calculateAverages();
                    document.querySelectorAll('#gradeTable input[type="number"]').forEach(updateScoreColor);
                }, 100);
                showSection('grades');
                closeQRModal();
                alert('Session loaded from QR!');
            } else {
                // If not confirmed, restart scanning
                startScanning(document.getElementById('qrVideo'));
            }
        } else {
            throw new Error('Invalid QR data');
        }
    } catch (err) {
        console.error('QR Parse Error:', err);
        document.getElementById('qrStatus').textContent = 'Invalid QR code. Try again.';
        // Restart scanning after 2s without closing modal
        setTimeout(() => startScanning(document.getElementById('qrVideo')), 2000);
    }
    // closeQRModal() moved to success path only
}

function closeQRModal() {
    const modal = document.getElementById('qrModal');
    modal.style.display = 'none';
    if (videoStream) {
        videoStream.getTracks().forEach(track => track.stop());
        videoStream = null;
    }
    if (qrScanningInterval) {
        clearInterval(qrScanningInterval);
        qrScanningInterval = null;
    }
}

// NEW: Generate QR for Session (called after save)
function generateQRForSession(session) {
    if (!session || typeof session !== 'object') {
        console.error('generateQRForSession called with invalid data:', session);
        alert('Could not generate QR code: session data is missing.');
        return;
    }
    const qrData = JSON.stringify(session);
    const canvas = document.createElement('canvas');
    QRCode.toCanvas(canvas, qrData, { width: 256 }, (err) => {
        if (err) {
            alert('QR Generation Failed: ' + err);
            return;
        }
        const link = document.createElement('a');
        link.download = `session-qr-${session.id}.png`;
        link.href = canvas.toDataURL();
        link.click();
        alert('QR code downloaded! Print or share it to scan later.');
    });
}

// NEW: OCR Camera Capture Functions
let ocrVideoStream = null;

function startOcrCamera() {
    const modal = document.getElementById('ocrCameraModal');
    const status = document.getElementById('ocrCameraStatus');
    modal.style.display = 'flex'; // Use flex for centering
    status.textContent = 'Requesting camera access...';

    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
        .then(stream => {
            ocrVideoStream = stream;
            const video = document.getElementById('ocrCameraVideo');
            video.srcObject = stream;
            video.play();
            status.textContent = 'Camera ready. Press Capture.';
        })
        .catch(err => {
            console.error('Camera Error:', err);
            status.textContent = 'Camera access denied. Please enable permissions in your browser settings.';
        });
}

function captureOcrImage() {
    const video = document.getElementById('ocrCameraVideo');
    const canvas = document.getElementById('ocrPreprocessCanvas'); // Reuse the hidden canvas
    const ctx = canvas.getContext('2d');

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const imageDataUrl = canvas.toDataURL('image/jpeg');

    // Now, use this image data for OCR
    resetOcrSection(); // Clear previous results
    document.getElementById('ocrPreviewImage').src = imageDataUrl;
    document.getElementById('ocrPreviewContainer').style.display = 'block';

    // Create a mock reader object for runOcr
    const mockReader = { result: imageDataUrl };
    runOcr(mockReader);

    // Close the camera modal and switch to the OCR section
    closeOcrCameraModal();
    showSection('ocr');
}

function closeOcrCameraModal() {
    const modal = document.getElementById('ocrCameraModal');
    modal.style.display = 'none';
    if (ocrVideoStream) {
        ocrVideoStream.getTracks().forEach(track => track.stop());
        ocrVideoStream = null;
    }
}

document.getElementById('ocrCameraModal').addEventListener('click', function(e) {
    if (e.target === this) closeOcrCameraModal();
});

// NEW: Convert PDF to image (basic stub - warns user for now; expand with pdf.js if needed)
async function handlePDFFile(file) {
    showToast('PDF detected! Convert to image first (e.g., screenshot or use online tool like ilovepdf.com).', 'info');
    // FUTURE: Integrate pdf.js for client-side conversion
    // For now, reject and suggest manual conversion
    throw new Error('PDF not supported yet—please convert to JPG/PNG.');
}

// NEW: Enhanced file validation (allows ANY file, but processes only images)
function isValidOcrFile(file) {
    const imageTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/tiff', 'image/heic'];
    const isImage = imageTypes.includes(file.type) || file.type.startsWith('image/');
    const isPDF = file.type === 'application/pdf';
    return isImage || isPDF;
}

// NEW: Get image from file (handles DataURL or canvas for PDFs/images)
async function getImageFromFile(file) {
    if (file.type === 'application/pdf') {
        await handlePDFFile(file); // Throws error with guidance
    }
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// UPDATED: Enhanced drop zone with better file validation
function setupOcrDropZone() {
    const dropZone = document.getElementById('ocrDropZone');
    const fileInput = document.getElementById('ocrFileInput');

    dropZone.addEventListener('click', (e) => {
        // Only trigger file input if the click is not on a button.
        // This prevents the file dialog from opening when "Take a Picture" is clicked.
        if (e.target.tagName !== 'BUTTON') {
            fileInput.click();
        }
    });

    // Drag & drop for any file
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, (e) => {
            e.preventDefault();
            e.stopPropagation();
        });
    });

    dropZone.addEventListener('dragover', () => dropZone.classList.add('dragover'));
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', (e) => {
        dropZone.classList.remove('dragover');
        const files = Array.from(e.dataTransfer.files);
        const validFiles = files.filter(isValidOcrFile);
        if (validFiles.length === 0) {
            showToast('Drop valid images (JPG, PNG, etc.) or PDFs (convert first).', 'error');
            return;
        }
        if (validFiles.length > 1) {
            showToast('Processing first file only (multi-file coming soon).', 'info');
        }
        // Create fake FileList for single file
        const dt = new DataTransfer();
        dt.items.add(validFiles[0]);
        fileInput.files = dt.files;
        handleOcrFileSelect({ target: fileInput });
    });
}

function handleOcrFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!isValidOcrFile(file)) {
        showToast('Unsupported file. Use images (JPG, PNG, GIF, WEBP, BMP, TIFF) or convert PDFs to images.', 'error');
        event.target.value = '';
        return;
    }

    showToast(`Loading: ${file.name} (${Math.round(file.size / 1024)} KB)`, 'info');
    resetOcrSection();

    getImageFromFile(file).then((imageData) => {
        console.log('File loaded for OCR:', file.name, file.type);
        document.getElementById('ocrPreviewImage').src = imageData;
        document.getElementById('ocrPreviewContainer').style.display = 'block';
        runOcr({ result: imageData }, file.name);
    }).catch((err) => {
        console.error('File load error:', err);
        showToast(err.message, 'error');
    });
}

function resetOcrSection() {
    document.getElementById('ocrPreviewContainer').style.display = 'none';
    document.getElementById('ocrPreviewImage').src = '#';
    document.getElementById('ocrProgress').style.display = 'none';
    document.getElementById('ocrProgressBar').style.width = '0%';
    document.getElementById('ocrProgressBar').style.backgroundColor = '#27ae60';
    document.getElementById('ocrProgressText').textContent = '';
    document.getElementById('ocrResultText').value = '';
}

// UPDATED: Advanced preprocessing (noise reduction + adaptive threshold)
async function preprocessImage(reader) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = 'anonymous'; // For external images
        img.onload = () => {
            const canvas = document.getElementById('ocrPreprocessCanvas');
            const ctx = canvas.getContext('2d');
            canvas.width = Math.min(img.width, 1200); // Resize for speed
            canvas.height = (img.height / img.width) * canvas.width;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

            // Grayscale
            let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let data = imageData.data;
            for (let i = 0; i < data.length; i += 4) {
                const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
                data[i] = data[i + 1] = data[i + 2] = avg;
            }
            ctx.putImageData(imageData, 0, 0);

            // Sharpen (simple unsharp mask)
            ctx.filter = 'contrast(150%) brightness(120%)';
            ctx.drawImage(canvas, 0, 0);

            // Adaptive threshold (better for uneven lighting)
            imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            data = imageData.data;
            const blockSize = 15;
            for (let y = 0; y < canvas.height; y++) {
                for (let x = 0; x < canvas.width; x++) {
                    const i = (y * canvas.width + x) * 4;
                    const avg = (data[i] + data[i + 1] + data[i + 2]) / 3;
                    // Local threshold (simple Gaussian-like)
                    let localAvg = 0, count = 0;
                    for (let dy = -blockSize; dy <= blockSize; dy++) {
                        for (let dx = -blockSize; dx <= blockSize; dx++) {
                            const ny = Math.max(0, Math.min(canvas.height - 1, y + dy));
                            const nx = Math.max(0, Math.min(canvas.width - 1, x + dx));
                            const ni = (ny * canvas.width + nx) * 4;
                            localAvg += (data[ni] + data[ni + 1] + data[ni + 2]) / 3;
                            count++;
                        }
                    }
                    const threshold = localAvg / count;
                    const isDark = avg < threshold;
                    data[i] = data[i + 1] = data[i + 2] = isDark ? 0 : 255;
                }
            }
            ctx.putImageData(imageData, 0, 0);

            console.log('Preprocessing complete:', canvas.width + 'x' + canvas.height);
            resolve(canvas.toDataURL('image/png')); // Return as PNG for quality
        };
        img.onerror = reject;
        img.src = reader.result;
    });
}

// UPDATED: Robust OCR with retries, better worker handling, and parameter fallback
async function runOcr(reader, filename = 'unknown') {
    const progressDiv = document.getElementById('ocrProgress');
    const progressBar = document.getElementById('ocrProgressBar');
    const progressText = document.getElementById('ocrProgressText');
    const resultText = document.getElementById('ocrResultText');

    progressDiv.style.display = 'block';
    progressText.textContent = 'Preparing image...';
    resultText.value = '';

    let retryCount = 0;
    const maxRetries = 2;

    const attemptOcr = async () => {
        try {
            const processedImage = await preprocessImage(reader);
            progressText.textContent = 'Initializing OCR engine...';

            const { createWorker } = Tesseract;
            const worker = await createWorker('eng', 1, {
                logger: (m) => {
                    console.log(`OCR (${filename}, attempt ${retryCount + 1}):`, m);
                    if (m.status === 'recognizing text') {
                        progressBar.style.width = `${Math.round(m.progress * 100)}%`;
                        progressText.textContent = `Scanning... ${Math.round(m.progress * 100)}%`;
                    } else {
                        progressText.textContent = m.status.replace('_', ' ').toUpperCase() + '...';
                    }
                },
                workerPath: 'https://unpkg.com/tesseract.js@v4.1.1/dist/worker.min.js',
                langPath: 'https://tessdata.projectnaptha.com/4.0.0',
                corePath: 'https://unpkg.com/tesseract.js-core@v4.1.1/tesseract-core.wasm.js', // NEW: Explicit core path for stability
            });

            // NEW: Validate worker before config
            if (!worker || typeof worker.setParameters !== 'function') {
                throw new Error('OCR worker failed to initialize—try refreshing the page.');
            }

            // UPDATED: Wrap parameters in try-catch (fixes SetVariable null error)
            try {
                // Optimized config for grades/tables
                await worker.setParameters({
                    tessedit_char_whitelist: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz :.,-()[]%',
                    tessedit_pageseg_mode: '3', // Auto (good for mixed text/tables)
                    tessedit_ocr_engine_mode: '1', // LSTM only (more accurate)
                });
                console.log('OCR parameters set successfully');
            } catch (paramError) {
                console.warn('Parameter setting failed (common with Tesseract v4)—using defaults:', paramError);
                // Fallback: Continue without custom params (still works)
            }

            progressText.textContent = 'Analyzing text...';

            const { data: { text, confidence } } = await worker.recognize(processedImage);
            await worker.terminate();

            if (confidence < 50) {
                throw new Error(`Low confidence (${Math.round(confidence)}%)—image may be blurry or unclear.`);
            }

            if (!text || !text.trim()) {
                throw new Error('No text detected—try a clearer image with more contrast.');
            }

            resultText.value = text.trim();
            progressText.textContent = `✅ Complete! Confidence: ${Math.round(confidence)}%`;
            progressBar.style.width = '100%';
            progressBar.style.backgroundColor = '#27ae60';

            showToast(`OCR success! Detected ${text.split(/\s+/).length} words across ${text.split('\n').length} lines.`, 'success');
        } catch (err) {
            console.error('OCR attempt failed:', err);
            if (retryCount < maxRetries) {
                retryCount++;
                progressText.textContent = `Retrying (${retryCount}/${maxRetries})...`;
                setTimeout(attemptOcr, 1000); // Longer delay for retries
                return;
            }

            // Final failure handling
            progressText.textContent = `❌ Failed after ${maxRetries + 1} tries: ${err.message}`;
            progressBar.style.width = '100%';
            progressBar.style.backgroundColor = '#e74c3c';
            resultText.value = `Error: ${err.message}\n\nTroubleshooting:\n• Ensure image has clear, dark text on light background\n• Avoid glare/shadows—use good lighting\n• Crop tightly to the text area\n• Try a different image format (JPG/PNG best)\n\n<button class="small-btn" onclick="document.getElementById('ocrFileInput').click(); resetOcrSection();">📁 Select New File</button>`;

            // Append retry button dynamically
            const existingBtn = resultText.parentNode.querySelector('.small-btn');
            if (!existingBtn) {
                const btn = document.createElement('button');
                btn.className = 'small-btn';
                btn.textContent = '🔄 Retry OCR';
                btn.style.marginTop = '10px';
                btn.onclick = () => {
                    document.getElementById('ocrFileInput').click();
                    resetOcrSection();
                };
                resultText.parentNode.appendChild(btn);
            }

            showToast('OCR failed—see tips above. Manual entry works too!', 'error');
        }
    };

    attemptOcr();
}

// UPDATED: Super flexible parsing (handles tables, lists, messy text)
function parseAndAddOcrGrades() {
    const text = document.getElementById('ocrResultText').value.trim();
    if (!text) return showToast('Run OCR first!', 'error');

    // Clean text: remove extra spaces, normalize
    const cleanedText = text.replace(/\s+/g, ' ').trim();
    const lines = cleanedText.split(/[\n\r]+/).map(line => line.trim()).filter(line => line.length > 2);

    if (lines.length === 0) return showToast('No readable lines found.', 'error');

    console.log('Parsing', lines.length, 'lines');
    addParsedGrades(lines);
    showToast(`Added ${lines.length} potential subjects! Calculate to see results.`, 'success');
    showSection('grades');
}

function addParsedGrades(lines) {
    let added = 0, skipped = 0;
    lines.forEach(line => {
        // Flexible patterns: "Subject 85 92" or "Math: 90, 85" or "Science (78 92 100)"
        const patterns = [
            /^([A-Za-z\s]+?)\s*[:\-]?\s*(\d+(?:\.\d+)?(?:\s*[,;]\s*|\s+)\d+(?:\.\d+)?)+$/i, // Colon/delimited
            /^([A-Za-z\s]+?)\s+(\d+(?:\.\d+)?(?:\s+|\s*[,;]\s*)+)$/i // Space separated
        ];

        let match;
        for (const pattern of patterns) {
            match = line.match(pattern);
            if (match) break;
        }

        if (match) {
            const subject = match[1].trim().replace(/[^\w\s]/g, '').substring(0, 25); // Clean name
            const scorePart = match[2].replace(/[,:;]/g, ' ').trim();
            const scores = scorePart.split(/\s+/).map(s => parseFloat(s)).filter(s => !isNaN(s) && s >= 0 && s <= 120); // Allow slight over 100

            if (scores.length >= 1 && subject) {
                addSubjectRow(subject);
                const inputs = document.querySelectorAll('#gradeTable tbody tr:last-child input[type="number"]');
                scores.slice(0, inputs.length).forEach((score, i) => {
                    inputs[i].value = Math.max(0, Math.min(100, Math.round(score))); // Clamp 0-100
                    updateScoreColor(inputs[i]);
                });
                added++;
            } else {
                skipped++;
            }
        } else {
            skipped++;
        }
    });

    if (added === 0) {
        showToast(`No matches (${skipped} lines skipped). Edit text manually or retry OCR.`, 'warning');
    } else {
        showToast(`${added} subjects added (${skipped} skipped).`, 'success');
    }
}

 // JS Fallback for www redirect (uncomment if no custom domain)
/*
if (window.location.hostname === 'www.suahco4.github.io') {
    window.location.replace('https://suahco4.github.io' + window.location.pathname);
}
*/

// Dynamic Meta Updates for SEO
function updateMetaForSection(section) {
    const titles = {
        'grades': 'Grade Calculator | Free Online GPA & Average Tool with PDF/CSV Export',
        'help': 'Help & Guide | Grade Calculator - Free GPA Tool',
        'ocr': 'Advanced OCR | Grade Calculator - Scan from Image',
        'settings': 'Settings | Grade Calculator - Customize Your Experience',
        'profile': 'Profile | Grade Calculator - Manage Account & Sessions',
        'contact': 'Contact Us | Grade Calculator - Get Support',
        'ai': 'Assistant | Grade Calculator - Smart Study Help',
        'privacy': 'Privacy Policy | Grade Calculator - Data Protection',
        'terms': 'Terms of Service | Grade Calculator - User Agreement'
    };
    document.title = titles[section] || 'Grade Calculator | Free Online GPA Tool';
    
    // Update meta description
    const metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc) {
        const descriptions = {
            'grades': 'Track grades across periods & exams with our free Grade Matrix Calculator. Calculate averages, export PDF/CSV, save sessions. Mobile-friendly & secure.',
            'help': 'Learn to use Grade Calculator: add subjects, calculate averages, export reports. Free GPA tool for students.',
            'ai': 'Chat with our assistant for grade advice, study tips, and tool help.',
            'contact': 'Contact Grade Calculator team for support on our free GPA tool.',
            'privacy': 'Grade Calculator Privacy Policy: how we protect your data.',
            'terms': 'Grade Calculator Terms of Service: rules for using our free grading tool.'
        };
        metaDesc.setAttribute('content', descriptions[section] || 'Track grades across periods & exams with our free Grade Matrix Calculator. Calculate averages, export PDF/CSV, save sessions. Mobile-friendly & secure.');
    }
}

// NEW: Toast Notification Function
function showToast(message, type = 'info', duration = 3000) {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
        success: '✅',
        error: '❌',
        info: 'ℹ️'
    };
    
    toast.innerHTML = `<span class="toast-icon">${icons[type] || ''}</span> ${message}`;
    container.appendChild(toast);
    
    // Animate in
    setTimeout(() => toast.classList.add('show'), 10);
    
    // Animate out and remove
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, duration);
}

// Firebase Auth Functions
function signUpWithEmail(email, password, name) {
    const { createUserWithEmailAndPassword, updateProfile } = window;
    const auth = window.auth;
    createUserWithEmailAndPassword(auth, email, password)
        .then((userCredential) => {
            const user = userCredential.user;
            return updateProfile(user, { displayName: name || email.split('@')[0] });
        })
        .then(() => {
            showToast('Account created! You are now logged in.', 'success');
            document.getElementById('authForm').reset();
            document.getElementById('authError').textContent = '';
            loadProfile();
        })
        .catch((error) => {
            console.error('Sign Up Error:', error);
            document.getElementById('authError').textContent = error.message;
        })
        .finally(() => {
            updateAuthButtonState(false);
        });
}

function signInWithEmail(email, password) {
    const { signInWithEmailAndPassword } = window;
    const auth = window.auth;
    signInWithEmailAndPassword(auth, email, password)
        .then((userCredential) => {
            showToast('Logged in successfully!', 'success');
            document.getElementById('authForm').reset();
            document.getElementById('authError').textContent = '';
            loadProfile();
        })
        .catch((error) => {
            console.error('Sign In Error:', error);
            document.getElementById('authError').textContent = error.message;
        })
        .finally(() => {
            updateAuthButtonState(false);
        });
}

function signOutUser() {
    const { signOut } = window;
    const auth = window.auth;
    signOut(auth).then(() => {
        showToast('You have been logged out successfully.', 'info');
        currentUser = null;
        updateAuthUI();
        showSection('grades');
    }).catch((error) => {
        console.error('Sign Out Error:', error);
    });
}

// Auth State Observer
function initAuth() {
    const { onAuthStateChanged } = window;
    const auth = window.auth;
    // Initial call to update UI immediately (sets to guest state)
    updateAuthUI();
    onAuthStateChanged(auth, (user) => {
        currentUser = user;
        updateAuthUI();
        if (user) {
            loadProfile();
        }
    });
}

function updateAuthUI() {
    const loginSection = document.getElementById('login-section');
    const mainApp = document.getElementById('main-app');    
    const profileInfo = document.getElementById('profileInfo');
    const navPic = document.getElementById('navProfilePic');
    const dropdown = document.getElementById('profileDropdown');

    if (currentUser) {
        // User is logged in: show app, hide login screen
        loginSection.style.display = 'none';
        mainApp.style.display = 'block';        
        profileInfo.classList.add('active'); // Show profile details
        navPic.src = currentUser.photoURL || 'Suahco4.png';
        dropdown.innerHTML = `
            <a href="#" onclick="showSection('profile')">Edit Profile</a>
            <a href="#" onclick="signOutUser()">Logout</a>
        `;
    } else {
        // User is logged out: show login screen, hide app. This is the default state.
        loginSection.style.display = 'flex';
        mainApp.style.display = 'none';
        profileInfo.classList.remove('active'); // Hide profile details
        navPic.src = 'Suahco4.png';
        dropdown.innerHTML = `
            <a href="#" onclick="showSection('profile')">Login</a>
        `;
    }
}

// Toggle between sign up/login form
function toggleAuthForm() {
    const submitBtn = document.getElementById('authSubmit');
    const toggleBtn = document.getElementById('toggleAuth');
    const nameGroup = document.getElementById('nameInputGroup');
    const title = document.getElementById('authTitle');
    const subtitle = document.getElementById('authSubtitle');
    const toggleText = toggleBtn.parentElement;

    if (submitBtn.textContent.includes('Create')) { // Currently in Sign Up mode
        submitBtn.textContent = 'Log In';
        nameGroup.style.display = 'none';
        title.textContent = 'Welcome Back!';
        subtitle.textContent = 'Log in to access your saved data.';
        toggleText.innerHTML = `Don't have an account? <button type="button" id="toggleAuth" class="auth-toggle-btn">Sign Up</button>`;
    } else {
        submitBtn.textContent = 'Create Account';
        nameGroup.style.display = 'block';
        title.textContent = 'Create an Account';
        subtitle.textContent = 'to save sessions and track your progress.';
        toggleText.innerHTML = `Already have an account? <button type="button" id="toggleAuth" class="auth-toggle-btn">Log In</button>`;
    }
    // Re-bind the new button
    document.getElementById('toggleAuth').addEventListener('click', toggleAuthForm);
}

// NEW: Update auth button state during submission
function updateAuthButtonState(isSubmitting) {
    const button = document.getElementById('authSubmit');
    button.disabled = isSubmitting;
    const originalText = button.textContent.includes('Create') ? 'Create Account' : 'Log In';
    button.textContent = isSubmitting ? 'Processing...' : originalText;
}

// Function to highlight scores below threshold in red
function updateScoreColor(input) {
    const value = parseFloat(input.value);
    if (value !== '' && !isNaN(value) && value < currentThreshold) {
        input.classList.add('low-score');
    } else {
        input.classList.remove('low-score');
    }
}

// UPDATED: Event delegation for real-time color updates (now debounced)
const debouncedUpdateColor = debounce(updateScoreColor, 300);
document.addEventListener('input', function(e) {
    if (e.target.type === 'number' && e.target.closest('#gradeTable')) {
        debouncedUpdateColor(e.target);
    }
});

// UPDATED: Add row (now with semester avg cells)
function addSubjectRow(defaultName = '') {
    subjectCount++;
    const tbody = document.querySelector('#gradeTable tbody');
    const row = document.createElement('tr');
    
    // Build the row with the new column order
    let scoreInputs1 = '';
    for (let i = 0; i < 4; i++) scoreInputs1 += `<td><input type="number" min="0" max="100" placeholder="Score"></td>`;
    let scoreInputs2 = '';
    for (let i = 4; i < 8; i++) scoreInputs2 += `<td><input type="number" min="0" max="100" placeholder="Score"></td>`;

    row.innerHTML = `
        <td>
            <input type="text" value="${defaultName}" placeholder="Enter subject name">
            <button class="remove-btn">Remove</button>
        </td>
        ${scoreInputs1}
        <td class="sem1-avg average-cell">0.00</td>
        ${scoreInputs2}
        <td class="sem2-avg average-cell">0.00</td>
        <td class="final-avg average-cell">0.00</td>
    `;
    tbody.appendChild(row);
    clearError();
}

// Function to remove a row
function removeRow(button) {
    button.closest('tr').remove();
    clearError();
}

// NEW: Reset semesters button
function resetSemesters() {
    if (confirm('Clear all semester scores? Subjects will remain.')) {
        document.querySelectorAll('#gradeTable input[type="number"]').forEach(input => input.value = '');
        calculateAverages(); // Recalc to show zeros
        toggleDownloadBtns(false); // Hide download buttons as there are no scores
        alert('Semesters reset!');
    }
}

// Show/hide download buttons
function toggleDownloadBtns(show) {
    const csvBtn = document.getElementById('downloadBtn');
    const pdfBtn = document.getElementById('pdfBtn');
    if (csvBtn) csvBtn.style.display = show ? 'inline-block' : 'none';
    if (pdfBtn) pdfBtn.style.display = show ? 'inline-block' : 'none';
}

// NEW: Toggle GPA mode
function toggleGPAScale() {
    isGPAMode = document.getElementById('gpaToggle').checked;
    localStorage.setItem('gpaMode', isGPAMode);
}

// NEW: Save school name to localStorage
function saveSchoolName() {
    const schoolName = document.getElementById('schoolNameInput').value.trim();
    localStorage.setItem('schoolName', schoolName);
    alert('School name saved!');
}

// UPDATED: Function to calculate averages (now with semester logic)

// REFACTORED: Central function to get all table data for exports
function getExportData() {
    const table = document.getElementById('gradeTable');
    const headers = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
    const bodyRows = [];
    const footerRows = [];

    // Get Body Data
    table.querySelectorAll('tbody tr').forEach(row => {
        const rowData = [];
        const subjectInput = row.querySelector('input[type="text"]');
        rowData.push(subjectInput ? subjectInput.value.trim() : ''); // Subject Name

        const scoreInputs = row.querySelectorAll('input[type="number"]');
        const avgCells = row.querySelectorAll('.average-cell');

        // Corresponds to P1-P4, E1
        scoreInputs.forEach((input, index) => {
            rowData.push(input.value || '');
            if (index === 3) { // After 1st Exam (index 3)
                rowData.push(avgCells[0] ? avgCells[0].textContent.trim() : ''); // 1st Sem Avg
            }
        });

        // After all scores, add the last two averages
        rowData.push(avgCells[1] ? avgCells[1].textContent.trim() : ''); // 2nd Sem Avg
        rowData.push(avgCells[2] ? avgCells[2].textContent.trim() : ''); // Final Avg
        bodyRows.push(rowData);
    });

    // Get Footer Data
    table.querySelectorAll('tfoot tr').forEach(row => {
        const rowData = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
        footerRows.push(rowData);
    });

    return { headers, bodyRows, footerRows };
}

// REFACTORED: Download CSV using the new data function
function downloadCSV() {
    if (document.querySelectorAll('#gradeTable tbody tr').length === 0) {
        alert('No data to export. Add subjects and scores first.');
        return;
    }

    const { headers, bodyRows, footerRows } = getExportData();
    let csvContent = '';

    // Helper to format a row for CSV
    const toCsvRow = (arr) => arr.map(val => `"${(val || '').replace(/"/g, '""')}"`).join(',') + '\n';

    csvContent += toCsvRow(headers);
    bodyRows.forEach(row => {
        csvContent += toCsvRow(row);
    });
    footerRows.forEach(row => {
        csvContent += toCsvRow(row);
    });

    // Filename
    const schoolName = localStorage.getItem('schoolName')?.trim() || 'grade-matrix';
    const sanitizedFilename = schoolName.replace(/[^a-z0-9]/gi, '_').toLowerCase();
    const includeDate = localStorage.getItem('dateInExport') !== 'false';
    const dateStr = includeDate ? `-${new Date().toISOString().split('T')[0]}` : '';
    const filename = `${sanitizedFilename}${dateStr}.csv`;

    // Download
    const blob = new Blob(["\uFEFF" + csvContent], { type: 'text/csv;charset=utf-8;' }); // Added BOM for Excel
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

// REFACTORED: Download PDF using the new data function
function downloadPDF() {
    if (document.querySelectorAll('#gradeTable tbody tr').length === 0) {
        alert('No data to export. Add subjects and scores first.');
        return;
    }

    try {
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF({ orientation: 'landscape' });
        const { headers, bodyRows, footerRows } = getExportData();

        // Add table to PDF
        doc.autoTable({
            head: [headers],
            body: bodyRows,
            foot: footerRows,
            startY: 22,
            theme: 'grid',
            styles: { fontSize: 8, cellPadding: 2, halign: 'center' },
            headStyles: { fillColor: [44, 73, 94] },
            footStyles: { fillColor: [232, 244, 253], textColor: [0, 0, 0], fontStyle: 'bold' },
            margin: { left: 10, right: 10 },
        });

        // Add title and footer text
        const reportTitle = localStorage.getItem('schoolName')?.trim() || 'Grade Matrix Report';
        doc.setFontSize(16);
        doc.text(reportTitle, 14, 15);

        doc.setFontSize(10);
        doc.text(`Overall Averages are listed in the table footer.`, 14, doc.lastAutoTable.finalY + 10);

        // Add timestamp footer
        const pageHeight = doc.internal.pageSize.height;
        doc.setFontSize(8);
        doc.text(`Generated: ${new Date().toLocaleString()}`, 14, pageHeight - 10);

        // Filename
        const sanitizedFilename = reportTitle.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const includeDate = localStorage.getItem('dateInExport') !== 'false';
        const dateStr = includeDate ? `-${new Date().toISOString().split('T')[0]}` : '';
        const filename = `${sanitizedFilename}${dateStr}.pdf`;

        // Download
        doc.save(filename);
    } catch (err) {
        console.error('PDF Export Error:', err);
        showError('PDF export failed. Check console or try a smaller table.');
    }
}


            function calculateAverages() {
try {
    const rows = document.querySelectorAll('#gradeTable tbody tr');
    if (rows.length === 0) {
        showError('Please add at least one subject.');
        return;
    }

    const scale = isGPAMode ? (score) => Math.min(4.0, score / 25) : (score) => score;

    // Reset all avgs (periods + semesters)
    columnIdMap.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '0.00';
    });
    ['sem1OverallAvg', 'sem2OverallAvg', 'finalOverallAvg'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = '0.00';
    });

    const columnTotals = new Array(numScoreColumns).fill(0);
    const columnCounts = new Array(numScoreColumns).fill(0);
    let sem1Total = 0, sem1Count = 0, sem2Total = 0, sem2Count = 0;
    let grandTotal = 0, grandCount = 0;
    let invalidSubjects = [];
    lastSubjectAvgs = [];

    // Per-subject calculations
    for (let r = 0; r < rows.length; r++) {
        const row = rows[r];
        const subjectInput = row.querySelector('input[type="text"]');
            const scoreInputs = Array.from(row.querySelectorAll('input[type="number"]'));
        const sem1AvgCell = row.querySelector('.sem1-avg');
        const sem2AvgCell = row.querySelector('.sem2-avg');
        const finalAvgCell = row.querySelector('.final-avg');

        if (!subjectInput || subjectInput.value.trim() === '') {
            invalidSubjects.push(r + 1);
            continue;
        }

        let sem1TotalRow = 0, sem1Valid = 0;
        let sem2TotalRow = 0, sem2Valid = 0;

        // Loop through all 8 score columns
        for (let i = 0; i < numScoreColumns; i++) {
            const input = scoreInputs[i];
            if (!input.value || input.value.trim() === '') continue;
            let score = parseFloat(input.value);
            if (isNaN(score) || score < 0 || score > 100) {
                showError('Scores must be numbers between 0 and 100.');
                return;
            }
            score = Math.min(100, Math.max(0, score));
            const scaled = scale(score);
            grandTotal += scaled;
            grandCount++;

            // Add to column total for period avg
            columnTotals[i] += scaled;
            columnCounts[i]++;

            // Add to semester totals
            if (i < 4) { // 1st Semester (0-3)
                sem1TotalRow += scaled;
                sem1Valid++;
                if (i < 3) { // Periods 1-3 for overall sem count
                    sem1Total += scaled;
                    sem1Count++;
                }
            } else { // 2nd Semester (4-7)
                sem2TotalRow += scaled;
                sem2Valid++;
                if (i > 4) { // Periods 4-6 for overall sem count
                    sem2Total += scaled;
                    sem2Count++;
                }
            }
        }

        // Subject semester avgs
        const sem1Avg = sem1Valid > 0 ? (sem1TotalRow / sem1Valid).toFixed(2) : '0.00';
        const sem2Avg = sem2Valid > 0 ? (sem2TotalRow / sem2Valid).toFixed(2) : '0.00';
        const finalAvg = (sem1Valid + sem2Valid > 0) ? ((sem1TotalRow + sem2TotalRow) / (sem1Valid + sem2Valid)).toFixed(2) : '0.00';

        const sem1Letter = getLetterGrade(sem1Avg, isGPAMode);
        const sem2Letter = getLetterGrade(sem2Avg, isGPAMode);
        const finalLetter = getLetterGrade(finalAvg, isGPAMode);

        if (sem1AvgCell) sem1AvgCell.innerHTML = `${sem1Avg} <small>(${sem1Letter})</small>`;
        if (sem2AvgCell) sem2AvgCell.innerHTML = `${sem2Avg} <small>(${sem2Letter})</small>`;
        if (finalAvgCell) finalAvgCell.innerHTML = `${finalAvg} <small>(${finalLetter})</small>`;

        lastSubjectAvgs.push({ 
            name: subjectInput.value.trim(), 
            sem1: parseFloat(sem1Avg), 
            sem2: parseFloat(sem2Avg), 
            final: parseFloat(finalAvg) 
        });
    }

    if (invalidSubjects.length > 0) {
        showError(`Please name subjects in rows: ${invalidSubjects.join(', ')}`);
        return;
    }

    // Footer: Individual period avgs (like before)
    for (let i = 0; i < numScoreColumns; i++) {
        const colAvg = columnCounts[i] > 0 ? (columnTotals[i] / columnCounts[i]).toFixed(2) : '0.00';
        const colId = columnIdMap[i];
        const el = document.getElementById(colId);
        if (el) el.innerHTML = `${colAvg} <small>(${getLetterGrade(colAvg, isGPAMode)})</small>`;
    }

    // Footer: Semester overall avgs (after periods)
    const sem1Overall = sem1Count > 0 ? (sem1Total / sem1Count).toFixed(2) : '0.00';
    const sem2Overall = sem2Count > 0 ? (sem2Total / sem2Count).toFixed(2) : '0.00';
    const finalOverall = grandCount > 0 ? (grandTotal / grandCount).toFixed(2) : '0.00';

    document.getElementById('sem1OverallAvg').innerHTML = `${sem1Overall} <small>(${getLetterGrade(sem1Overall, isGPAMode)})</small>`;
    document.getElementById('sem2OverallAvg').innerHTML = `${sem2Overall} <small>(${getLetterGrade(sem2Overall, isGPAMode)})</small>`;
    document.getElementById('finalOverallAvg').innerHTML = `${finalOverall} <small>(${getLetterGrade(finalOverall, isGPAMode)})</small>`;

    // Track active columns (all 8 now)
    activeColumns = Array.from({length: 8}, (_, i) => i);

    displayResult({ sem1: sem1Overall, sem2: sem2Overall, final: finalOverall });
    generateStats();
    clearError();
    toggleDownloadBtns(true);
} catch (err) {
    console.error(err);
    showError('An unexpected error occurred. Check the console for details.');
}
}


// UPDATED: Display result (now shows semester breakdown)
function displayResult(avgs) {
const resultDiv = document.getElementById('result');
const sem1Letter = getLetterGrade(avgs.sem1, isGPAMode);
const sem2Letter = getLetterGrade(avgs.sem2, isGPAMode);
const finalLetter = getLetterGrade(avgs.final, isGPAMode);
let displayText = `Periods: ${columnNames.map((name, i) => `${name}: ${document.getElementById(columnIdMap[i]).textContent.split(' ')[0]}`).join(' | ')} | 1st Sem: ${avgs.sem1} (${sem1Letter}) | 2nd Sem: ${avgs.sem2} (${sem2Letter}) | Final: ${avgs.final} (${finalLetter})`;
if (isGPAMode) {
    displayText += ' (GPA Mode)';
}
resultDiv.innerHTML = `<div class="result">${displayText}</div>`;
}

// Function to show error
function showError(message) {
    const errorDiv = document.getElementById('error');
    if (errorDiv) errorDiv.textContent = message;
}

// Function to clear error
function clearError() {
    const errorDiv = document.getElementById('error');
    if (errorDiv) errorDiv.textContent = '';
}

// FIXED: Toggle mobile nav menu - now closes if open on section change
function toggleNav() {
    const menu = document.getElementById('navMenu');
    menu.classList.toggle('active');
}

// FIXED: Close mobile nav if open (no toggle - force close)
function closeMobileNav() {
    const menu = document.getElementById('navMenu');
    if (menu.classList.contains('active')) {
        menu.classList.remove('active');
    }
}

// Toggle profile dropdown
function toggleProfileMenu() {
    const dropdown = document.getElementById('profileDropdown');
    dropdown.classList.toggle('active');
}

// Hide dropdown on outside click
document.addEventListener('click', function(e) {
    const dropdown = document.getElementById('profileDropdown');
    const profilePic = document.querySelector('.profile-pic');
    if (!profilePic.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.remove('active');
    }
});

// Logout function (now uses Firebase)
function logout() {
    signOutUser();
}

// Updated Profile functions (integrates with Firebase)
function loadProfile() {
    if (currentUser) {
        document.getElementById('userName').value = currentUser.displayName || '';
        document.getElementById('userEmail').value = currentUser.email || '';
        const picSrc = currentUser.photoURL || 'Suahco4.png';
        document.getElementById('profilePicPreview').src = picSrc;
        document.getElementById('navProfilePic').src = picSrc;
        generateStats();
        loadSessions();
        // NEW: Refresh stats on load
        if (lastOverallAvg !== '0.00') generateStats();
    }
}

function saveProfile() {
    if (!currentUser) return alert('Please log in first.');
    const name = document.getElementById('userName').value;
    const { updateProfile } = window;
    updateProfile(currentUser, { displayName: name })
        .then(() => {
            alert('Profile saved!');
            updateNavPic(currentUser.photoURL || 'Suahco4.png');
        })
        .catch((error) => {
            console.error('Profile Update Error:', error);
            alert('Failed to save profile.');
        });
}

function handlePicUpload(event) {
    const file = event.target.files[0];
    if (file && currentUser) {
        const reader = new FileReader();
        reader.onload = function(e) {
            const img = document.getElementById('profilePicPreview');
            img.src = e.target.result;
            updateNavPic(e.target.result);
            // TODO: Upload to Firebase Storage if needed
        };
        reader.readAsDataURL(file);
    }
}

function updateNavPic(src) {
    document.getElementById('navProfilePic').src = src;
}

// UPDATED: Save Session (now generates QR)
function saveSession() {
    const tableData = [];
    document.querySelectorAll('#gradeTable tbody tr').forEach(row => {
        const subjectInput = row.querySelector('input[type="text"]');
        const scoreInputs = Array.from(row.querySelectorAll('input[type="number"]')).map(input => input.value);
        tableData.push({
            subject: subjectInput ? subjectInput.value : '',
            scores: scoreInputs
        });
    });
    const session = {
        id: Date.now(),
        timestamp: new Date().toLocaleString(),
        data: tableData,
        overallAvg: lastOverallAvg
    };
    let sessions = JSON.parse(localStorage.getItem('savedSessions')) || [];
    sessions.unshift(session); // Add to front
    if (sessions.length > 5) sessions = sessions.slice(0, 5); // Limit to 5
    localStorage.setItem('savedSessions', JSON.stringify(sessions));
    loadSessions();
    // NEW: Generate QR
    generateQRForSession(session);
}

// NEW: Generate QR for the current, unsaved session data
function generateCurrentSessionQR() {
    const tableData = [];
    document.querySelectorAll('#gradeTable tbody tr').forEach(row => {
        const subjectInput = row.querySelector('input[type="text"]');
        const scoreInputs = Array.from(row.querySelectorAll('input[type="number"]')).map(input => input.value);
        tableData.push({
            subject: subjectInput ? subjectInput.value : '',
            scores: scoreInputs
        });
    });

    if (tableData.length === 0) return alert('No data in the table to generate a QR code.');

    const session = {
        id: 'current-' + Date.now(),
        timestamp: new Date().toLocaleString() + ' (Unsaved)',
        data: tableData,
        overallAvg: lastOverallAvg
    };
    generateQRForSession(session);
}

function loadSessions() {
    const sessions = JSON.parse(localStorage.getItem('savedSessions')) || [];
    const list = document.getElementById('sessionList');
    list.innerHTML = '';
    sessions.forEach(session => {
        const li = document.createElement('li');
        li.className = 'session-item';

        const span = document.createElement('span');
        span.textContent = `${session.timestamp} (Avg: ${session.overallAvg}%)`;

        const div = document.createElement('div');

        // Load button
        const loadBtn = document.createElement('button');
        loadBtn.className = 'small-btn';
        loadBtn.textContent = 'Load';
        loadBtn.onclick = () => loadSession(session.id);
        div.appendChild(loadBtn);

        // QR button
        const qrBtn = document.createElement('button');
        qrBtn.className = 'small-btn';
        qrBtn.style.backgroundColor = '#1abc9c';
        qrBtn.textContent = 'QR';
        qrBtn.onclick = () => generateQRForSession(session);
        div.appendChild(qrBtn);

        // Delete button
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'remove-btn';
        deleteBtn.textContent = 'Delete';
        deleteBtn.onclick = () => deleteSession(session.id);
        div.appendChild(deleteBtn);

        li.appendChild(span);
        li.appendChild(div);
        list.appendChild(li);
    });
}

// UPDATED: Load session (now auto-recalculates)
function loadSession(id) {
    const sessions = JSON.parse(localStorage.getItem('savedSessions')) || [];
    const session = sessions.find(s => s.id === id);
    if (!session) return alert('Session not found!');
    if (confirm(`Load session from ${session.timestamp}? This will overwrite current data.`)) {
        // Clear table
        document.querySelector('#gradeTable tbody').innerHTML = '';
        // Add rows
        session.data.forEach(item => {
            addSubjectRow(item.subject);
            const inputs = document.querySelectorAll('#gradeTable tbody tr:last-child input[type="number"]');
            item.scores.forEach((score, i) => {
                if (inputs[i]) inputs[i].value = score;
            });
        });
        // NEW: Auto-recalculate after DOM update
        setTimeout(() => calculateAverages(), 200);
        showSection('grades');
        alert('Session loaded!');
    }
}

function deleteSession(id) {
    if (confirm('Delete this session?')) {
        let sessions = JSON.parse(localStorage.getItem('savedSessions')) || [];
        sessions = sessions.filter(s => s.id !== id);
        localStorage.setItem('savedSessions', JSON.stringify(sessions));
        loadSessions();
    }
}

// UPDATED: Generate stats (with GPA support)
function generateStats() {
    // 1. Basic Stats Grid
    const statsGrid = document.getElementById('statsGrid');
    if (lastSubjectAvgs.length === 0) {
        statsGrid.innerHTML = '<p class="stat-item">No data yet. Calculate grades first!</p>';
        // Clear charts if they exist
        if (subjectBarChart) subjectBarChart.destroy();
        if (gradePieChart) gradePieChart.destroy();
        return;
    }
    const totalSubjects = lastSubjectAvgs.length;
    const bestSubject = lastSubjectAvgs.reduce((max, curr) => curr.final > max.final ? curr : max);
    const worstSubject = lastSubjectAvgs.reduce((min, curr) => curr.final < min.final ? curr : min);
    const overallDisplay = isGPAMode ? `${lastOverallAvg} GPA` : `${lastOverallAvg}%`;

    statsGrid.innerHTML = `
        <div class="stat-item">
            <div>Total Subjects</div>
            <div class="stat-value">${totalSubjects}</div>
        </div>
        <div class="stat-item">
            <div>Overall</div>
            <div class="stat-value">${overallDisplay}</div>
        </div>
        <div class="stat-item">
            <div>Best: ${bestSubject.name}</div>
            <div class="stat-value">${isGPAMode ? bestSubject.final.toFixed(2) : bestSubject.final}%</div>
        </div>
        <div class="stat-item">
            <div>Worst: ${worstSubject.name}</div>
            <div class="stat-value">${isGPAMode ? worstSubject.final.toFixed(2) : worstSubject.final}%</div>
        </div>
    `;

    // 2. Chart Visualizations
    // Destroy old charts before creating new ones
    if (subjectBarChart) subjectBarChart.destroy();
    if (gradePieChart) gradePieChart.destroy();

    // Bar Chart: Subject Performance
    const barCtx = document.getElementById('subjectBarChart').getContext('2d');
    subjectBarChart = new Chart(barCtx, {
        type: 'bar',
        data: {
            labels: lastSubjectAvgs.map(s => s.name),
            datasets: [{
                label: isGPAMode ? 'Final GPA' : 'Final Average (%)',
                data: lastSubjectAvgs.map(s => s.final),
                backgroundColor: lastSubjectAvgs.map(s => s.final < currentThreshold ? 'rgba(231, 76, 60, 0.6)' : 'rgba(52, 152, 219, 0.6)'),
                borderColor: lastSubjectAvgs.map(s => s.final < currentThreshold ? 'rgba(231, 76, 60, 1)' : 'rgba(52, 152, 219, 1)'),
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            plugins: {
                title: { display: true, text: 'Subject Performance' },
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    max: isGPAMode ? 4.0 : 100
                }
            }
        }
    });

    // Pie Chart: Grade Distribution
    const gradeCounts = { 'A': 0, 'B': 0, 'C': 0, 'D': 0, 'F': 0 };
    lastSubjectAvgs.forEach(s => {
        const letter = getLetterGrade(s.final, isGPAMode);
        // Handle A-, B+, etc. by grouping them
        const mainGrade = letter.charAt(0);
        if (gradeCounts.hasOwnProperty(mainGrade)) {
            gradeCounts[mainGrade]++;
        }
    });

    const pieCtx = document.getElementById('gradePieChart').getContext('2d');
    gradePieChart = new Chart(pieCtx, {
        type: 'pie',
        data: {
            labels: Object.keys(gradeCounts),
            datasets: [{
                label: 'Grade Distribution',
                data: Object.values(gradeCounts),
                backgroundColor: ['#27ae60', '#2980b9', '#f39c12', '#e67e22', '#e74c3c'],
            }]
        },
        options: {
            responsive: true,
            plugins: {
                title: { display: true, text: 'Grade Distribution' }
            }
        }
    });
}

// UPDATED: Contact functions (with fixed auto-reply)
async function submitContactForm(e) {
    e.preventDefault();
    const name = document.getElementById('contactName').value.trim();
    const email = document.getElementById('contactEmail').value.trim();
    const subject = document.getElementById('contactSubject').value.trim();
    const message = document.getElementById('contactMessage').value.trim();
    
    if (!name || !email || !subject || !message) {
        alert('Please fill in all fields.');
        return;
    }
    
    const submitButton = e.target.querySelector('button[type="submit"]');
    submitButton.disabled = true;
    submitButton.textContent = 'Sending...';
    
    try {
        // Step 1: Send the main contact email to yourself
        await emailjs.send('service_t4jdpwc', 'template_bq7h8n6', {
            name: name,
            email: email,
            subject: subject,
            message: message
        });
        console.log('Main contact email sent successfully.');
        
        // Step 2: Send the auto-reply to the user
        await emailjs.send('service_t4jdpwc', 'template_uh6ebet', {
            to_name: name,
            to_email: email,
            email: email, // Add 'email' as a fallback for the recipient address
            reply_subject: `Re: ${subject} - Thanks for reaching out!`,
            reply_message: `Hi ${name}! We received your message about "${subject}". Our team will review it within 24-48 hours. In the meantime, check our Help section for quick tips. Best, Grade Calculator Team`
        });
        console.log('Auto-reply sent successfully.');
        
        alert('Message sent successfully! Check your email for an auto-reply confirmation. We\'ll get back to you soon.');
        document.getElementById('contactForm').reset();
    } catch (error) {
        console.error('EmailJS Error:', error);
        alert(`Failed to send message. Please try again or email us directly. Error: ${error.text || 'Unknown error'}`);
    } finally {
        submitButton.disabled = false;
        submitButton.textContent = 'Send Message';
    }
}

// FIXED: Show section (handles all toggles + SEO meta updates) - Closes mobile nav
function showSection(section) {
    // Hide all sections
    document.querySelectorAll('section').forEach(sec => {
        sec.style.display = 'none';
    });
    
    // Show target
    if (section === 'grades') {
        const gradesSec = document.getElementById('grades-section');
        if (gradesSec) gradesSec.style.display = 'block';
        document.getElementById('result').style.display = 'block';
        document.getElementById('error').style.display = 'block';
    } else if (section === 'help') {
        const helpSec = document.getElementById('help-section');
        if (helpSec) helpSec.style.display = 'block';
        document.querySelectorAll('.accordion-content').forEach(content => content.classList.remove('active'));
    } else if (section === 'settings') {
        const settingsSec = document.getElementById('settings-section');
        if (settingsSec) settingsSec.style.display = 'block';
        loadSettings();
    } else if (section === 'profile') {
        const profileSec = document.getElementById('profile-section');
        if (profileSec) profileSec.style.display = 'block';
        loadProfile();
    } else if (section === 'ai') { // UPDATED: Now opens floating chat instead
        toggleFloatingChat();
        return; // Don't proceed to show full section
    } else if (section === 'ocr') {
        const ocrSec = document.getElementById('ocr-section');
        if (ocrSec) ocrSec.style.display = 'block';
        // resetOcrSection(); // Let's not reset, so user can see previous result
    } else if (section === 'contact') {
        const contactSec = document.getElementById('contact-section');
        if (contactSec) contactSec.style.display = 'block';
        document.getElementById('contactName').focus();
    } else if (section === 'privacy') {
        const privacySec = document.getElementById('privacy-section');
        if (privacySec) privacySec.style.display = 'block';
        document.querySelectorAll('.accordion-content').forEach(content => content.classList.remove('active'));
        document.querySelector('.accordion-content').classList.add('active');
    } else if (section === 'terms') {
        const termsSec = document.getElementById('terms-section');
        if (termsSec) termsSec.style.display = 'block'; // FIXED: Was privacySec
        document.querySelectorAll('.accordion-content').forEach(content => content.classList.remove('active'));
        document.querySelector('.accordion-content').classList.add('active');
    }
    
    // FIXED: Force close mobile nav on section change
    closeMobileNav();
    document.getElementById('profileDropdown').classList.remove('active');
    
    // Update SEO meta for this section
    updateMetaForSection(section);
}

// Toggle accordion sections
function toggleAccordion(header) {
    const contentWrapper = header.nextElementSibling;
    const contentInner = contentWrapper.querySelector('div'); // The div with the actual content
    const isActive = contentWrapper.classList.contains('active');
    
    // Close all other accordions
    document.querySelectorAll('.help-card h2').forEach(h => h.classList.remove('active'));
    document.querySelectorAll('.accordion-content').forEach(c => {
        if (c !== contentWrapper) {
            c.classList.remove('active');
            c.style.padding = '0 20px'; // Collapse padding
        }
    });
    
    // Toggle the clicked one
    header.classList.toggle('active', !isActive);
    contentWrapper.classList.toggle('active', !isActive);
    contentWrapper.style.padding = isActive ? '0 20px' : '20px'; // Animate padding
}

// Load saved settings
function loadSettings() {
    // Theme
    const isDark = localStorage.getItem('darkMode') === 'true';
    document.getElementById('themeToggle').checked = isDark;
    if (isDark) document.body.classList.add('dark-mode');
    
    // Threshold
    const threshold = localStorage.getItem('lowScoreThreshold') || 70;
    document.getElementById('thresholdInput').value = threshold;
    document.getElementById('currentThreshold').textContent = threshold;
    currentThreshold = parseInt(threshold);
    
    // GPA Mode
    isGPAMode = localStorage.getItem('gpaMode') === 'true';
    document.getElementById('gpaToggle').checked = isGPAMode;
    
    // Default subjects
    const defaults = localStorage.getItem('defaultSubjects') || 'Mathematics,English,Science,History';
    document.getElementById('defaultSubjectsInput').value = defaults;

    // School Name
    const schoolName = localStorage.getItem('schoolName') || '';
    document.getElementById('schoolNameInput').value = schoolName;
    
    // Date in export
    const dateInExport = localStorage.getItem('dateInExport') !== 'false';
    document.getElementById('dateInFilename').checked = dateInExport;
}

// Toggle dark mode
function toggleTheme() {
    const isDark = document.getElementById('themeToggle').checked;
    document.body.classList.toggle('dark-mode', isDark);
    localStorage.setItem('darkMode', isDark);
}

// UPDATED: Update low score threshold (with validation)
function updateThreshold() {
    const newVal = parseInt(document.getElementById('thresholdInput').value);
    if (isNaN(newVal) || newVal < 0 || newVal > 100) {
        showError('Threshold must be a number between 0-100.');
        return;
    }
    currentThreshold = newVal;
    document.getElementById('currentThreshold').textContent = newVal;
    localStorage.setItem('lowScoreThreshold', newVal);
    // Re-apply to all inputs
    document.querySelectorAll('#gradeTable input[type="number"]').forEach(input => {
        updateScoreColor(input);
    });
    clearError();
}

function applyThreshold() {
    updateThreshold();
    alert(`Threshold updated to ${currentThreshold}! Highlights refreshed.`);
}

// Save default subjects
function saveDefaultSubjects() {
    const subjects = document.getElementById('defaultSubjectsInput').value;
    localStorage.setItem('defaultSubjects', subjects);
    alert('Default subjects saved! Refresh page to see changes.');
}

// Toggle date in exports
function toggleDateInExport() {
    const includeDate = document.getElementById('dateInFilename').checked;
    localStorage.setItem('dateInExport', includeDate);
}

// Clear all data
function clearAllData() {
    if (confirm('Clear all subjects and scores? This cannot be undone.')) {
        document.querySelector('#gradeTable tbody').innerHTML = '';
        const defaults = localStorage.getItem('defaultSubjects') || 'Mathematics,English,Science,History';
        defaults.split(',').forEach(name => addSubjectRow(name.trim()));
        toggleDownloadBtns(false); // Corrected from toggleDownloadBtns
        activeColumns = [];
        columnIdMap.forEach(id => document.getElementById(id).textContent = '0.00');
        document.getElementById('sem1OverallAvg').textContent = '0.00';
        document.getElementById('sem2OverallAvg').textContent = '0.00';
        document.getElementById('finalOverallAvg').textContent = '0.00';
        document.getElementById('result').innerHTML = '';
        clearError();
        alert('Data cleared! Back to defaults.');
        showSection('grades');
    }
}

// NEW: Keyboard shortcut for calculate (Ctrl+Enter)
document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
        e.preventDefault();
        calculateAverages();
    }
});

// Event listeners & Initial Load
document.addEventListener('DOMContentLoaded', function() {
    // FIXED: Force close mobile nav on load/refresh
    closeMobileNav();

    // NEW: Set current year in footer
    document.getElementById('copyrightYear').textContent = new Date().getFullYear();

    // Initialize EmailJS
    emailjs.init('mMoFbLBQtA226NQY_');

    // Initialize Firebase Auth (now calls updateAuthUI immediately)
    initAuth();

    // Bind main buttons
    document.getElementById('addSubject').addEventListener('click', () => addSubjectRow(''));
    document.getElementById('calculate').addEventListener('click', calculateAverages);
    document.getElementById('resetSemesters').addEventListener('click', resetSemesters); // NEW

    // NEW: OCR Event Listeners
    setupOcrDropZone();
    document.getElementById('ocrFileInput').addEventListener('change', handleOcrFileSelect);
    
    // Event delegation for remove buttons (dynamic)
    document.addEventListener('click', function(e) {
        if (e.target.classList.contains('remove-btn')) {
            removeRow(e.target);
        }
    });

    // Auth form submit
    document.getElementById('authForm').addEventListener('submit', function(e) {
        e.preventDefault();
        const email = document.getElementById('authEmail').value;
        const password = document.getElementById('authPassword').value;
        const name = document.getElementById('signupName').value;
        const submitBtn = document.getElementById('authSubmit');

        updateAuthButtonState(true); // Disable button

        if (submitBtn.textContent.includes('Create')) {
            signUpWithEmail(email, password, name);
        } else {
            signInWithEmail(email, password);
        }
    });

    // Toggle auth form
    document.getElementById('toggleAuth').addEventListener('click', toggleAuthForm);

    // Contact form submit
    document.getElementById('contactForm').addEventListener('submit', submitContactForm);

    // Load defaults
    const defaultSubjects = ['Mathematics', 'English', 'Science', 'History'];
    defaultSubjects.forEach(name => addSubjectRow(name));

    // Load settings & profile
    loadSettings();
    toggleDownloadBtns(false);
    showSection('grades'); // This will also set initial SEO meta

    // NEW: Close QR modal on outside click
    document.getElementById('qrModal').addEventListener('click', function(e) {
        if (e.target === this) closeQRModal();
    });
});