window.PDFViewer = {
    config: {
        isEnabled: true,
        autoOpen: true,
        basePath: 'pdfs/'
    },

    state: {
        pdfDoc: null,
        scale: 1.0,
        currentFilename: null 
    },

    // 1. Process Text
    processText: function(text) {
        if (!this.config.isEnabled) return text;
        const regex = /\|\|PDF:(.*?)\|\|/g;
        
        if (this.config.autoOpen) {
            const match = text.match(regex);
            if (match) {
                const filename = match[0].replace('||PDF:', '').replace('||', '').trim();
                this.open(filename); 
            }
        }

        return text.replace(regex, (match, filename) => {
            const cleanName = filename.trim();
            return `<span class="pdf-chat-link" onclick="PDFViewer.open('${cleanName}')">📄 View Document: ${cleanName}</span>`;
        });
    },

    // 2. Open & Setup
    open: function(filename) {
        if (!this.config.isEnabled) return;

        // Save filename to state so we can download it later
        this.state.currentFilename = filename;

        const url = this.config.basePath + filename;
        const overlay = document.getElementById('pdf-overlay');
        const title = document.getElementById('pdf-filename');

        overlay.classList.remove('pdf-hidden');
        title.innerText = filename;

        // Reset scale based on device
        this.state.scale = window.innerWidth < 768 ? 0.6 : 1.0;

        pdfjsLib.getDocument(url).promise.then(doc => {
            this.state.pdfDoc = doc;
            this.renderAllPages(); 
        }).catch(err => {
            console.error('[PDFViewer] Error:', err);
            title.innerText = "Error: File not found";
        });
    },

    // 3. Render ALL Pages
    renderAllPages: function() {
        if (!this.state.pdfDoc) return;

        const container = document.getElementById('pdf-scroll-container');
        container.innerHTML = ''; // Clear previous PDF

        for (let i = 1; i <= this.state.pdfDoc.numPages; i++) {
            this.renderSinglePage(i, container);
        }
    },

    // 4. Render Single Page
    renderSinglePage: function(pageNum, container) {
        this.state.pdfDoc.getPage(pageNum).then(page => {
            const canvas = document.createElement('canvas');
            canvas.style.display = "block";
            canvas.style.marginBottom = "10px";
            canvas.style.boxShadow = "0 2px 5px rgba(0,0,0,0.3)";
            canvas.style.background = "white";
            
            container.appendChild(canvas);

            const ctx = canvas.getContext('2d');
            const dpr = window.devicePixelRatio || 1;
            const viewport = page.getViewport({ scale: this.state.scale });

            canvas.width = Math.floor(viewport.width * dpr);
            canvas.height = Math.floor(viewport.height * dpr);
            canvas.style.width = `${Math.floor(viewport.width)}px`;
            canvas.style.height = `${Math.floor(viewport.height)}px`;

            const renderCtx = {
                canvasContext: ctx,
                viewport: viewport,
                transform: [dpr, 0, 0, dpr, 0, 0]
            };

            page.render(renderCtx);
        });
    },

    // 5. Zoom
    zoom: function(delta) {
        if (!this.state.pdfDoc) return;
        
        let newScale = this.state.scale + delta;
        newScale = Math.round(newScale * 10) / 10;

        if (newScale >= 0.4 && newScale <= 3.0) {
            this.state.scale = newScale;
            this.renderAllPages();
        }
    },

    // 6. Download
    download: function() {
        if (!this.state.currentFilename) return;

        const path = this.config.basePath + this.state.currentFilename;
        
        // Create a temporary link to trigger the download
        const link = document.createElement('a');
        link.href = path;
        link.download = this.state.currentFilename; // Suggests the filename to save as
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    },

    // 7. Close
    close: function() {
        document.getElementById('pdf-overlay').classList.add('pdf-hidden');
        document.getElementById('pdf-scroll-container').innerHTML = ''; 
        this.state.pdfDoc = null;
        this.state.currentFilename = null; // Clear filename
    }
};
