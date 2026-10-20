import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const API_BASE = "/api";

const createImage = (file) => ({
  id: `${file.name}-${file.lastModified}-${Math.random()}`,
  name: file.name || "Pasted image",
  url: URL.createObjectURL(file),
  file,
});

function App() {
  const [images, setImages] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [isDragging, setIsDragging] = useState(false);

  const inputRef = useRef(null);
  const imagesRef = useRef([]);
  imagesRef.current = images;

  // 0.5s upload debounce refs
  const pendingUploadsRef = useRef([]);
  const uploadDebounceTimerRef = useRef(null);

  // 1.0s removal debounce refs
  const removeDebounceTimersRef = useRef({});

  // Fetch stored images on mount
  useEffect(() => {
    const fetchImages = async () => {
      try {
        const res = await fetch(`${API_BASE}/images`);
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data.images) && data.images.length > 0) {
            setImages(data.images);
            setSelectedId(data.images[0].id);
          }
        }
      } catch (err) {
        console.warn("Could not load stored images:", err);
      }
    };

    fetchImages();
  }, []);

  // Upload batch to backend/Cloudinary
  const uploadBatch = async (batch) => {
    if (!batch.length) return;

    const formData = new FormData();
    batch.forEach((item) => {
      if (item.file) {
        formData.append("images", item.file, item.name);
      }
    });

    try {
      const res = await fetch(`${API_BASE}/images/upload`, {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        const result = await res.json();
        const serverImages = result.images || [];

        setImages((current) => {
          let updated = [...current];
          batch.forEach((localItem, index) => {
            const serverImage = serverImages[index];
            const idx = updated.findIndex((img) => img.id === localItem.id);
            if (idx !== -1 && serverImage) {
              if (updated[idx].url?.startsWith("blob:")) {
                URL.revokeObjectURL(updated[idx].url);
              }
              updated[idx] = serverImage;
            }
          });
          return updated;
        });
      }
    } catch (err) {
      console.error("Upload error:", err);
    }
  };

  // Add files with 0.5s debounce for storing
  const addFiles = useCallback((fileList) => {
    const newImages = Array.from(fileList || [])
      .filter((file) => file.type.startsWith("image/"))
      .map(createImage);

    if (!newImages.length) return;

    // Show in UI immediately
    setImages((current) => [...current, ...newImages]);
    setSelectedId((current) => current || newImages[0].id);

    // Queue for debounced upload
    pendingUploadsRef.current.push(...newImages);

    // Debounce of 0.5 sec (500ms) for storing copied/added images
    if (uploadDebounceTimerRef.current) {
      clearTimeout(uploadDebounceTimerRef.current);
    }

    uploadDebounceTimerRef.current = setTimeout(() => {
      const batchToUpload = [...pendingUploadsRef.current];
      pendingUploadsRef.current = [];
      uploadBatch(batchToUpload);
    }, 500);
  }, []);

  // Clipboard paste listener
  useEffect(() => {
    const handlePaste = (event) => {
      const files = Array.from(event.clipboardData?.items || [])
        .map((item) => {
          return item.kind === "file" ? item.getAsFile() : null;
        })
        .filter(Boolean);

      if (files.length) {
        addFiles(files);
      }
    };

    window.addEventListener("paste", handlePaste);

    return () => {
      window.removeEventListener("paste", handlePaste);
    };
  }, [addFiles]);

  // Clean up timers & object URLs on unmount
  useEffect(() => {
    return () => {
      if (uploadDebounceTimerRef.current) {
        clearTimeout(uploadDebounceTimerRef.current);
      }
      Object.values(removeDebounceTimersRef.current).forEach((t) =>
        clearTimeout(t)
      );
      imagesRef.current.forEach((image) => {
        if (image.url?.startsWith("blob:")) {
          URL.revokeObjectURL(image.url);
        }
      });
    };
  }, []);

  // Remove image with 1.0s debounce
  const removeImage = (id) => {
    // If already scheduled for removal, prevent duplicate timers
    if (removeDebounceTimersRef.current[id]) {
      return;
    }

    // Cancel from pending upload queue if removed before 0.5s upload fired
    pendingUploadsRef.current = pendingUploadsRef.current.filter(
      (item) => item.id !== id
    );

    // 1.0s debounce before removing from UI and backend
    removeDebounceTimersRef.current[id] = setTimeout(async () => {
      delete removeDebounceTimersRef.current[id];

      // Remove from UI
      setImages((current) => {
        const image = current.find((item) => item.id === id);
        if (image && image.url?.startsWith("blob:")) {
          URL.revokeObjectURL(image.url);
        }
        return current.filter((item) => item.id !== id);
      });

      setSelectedId((current) => (current === id ? null : current));

      // Call backend DELETE
      try {
        await fetch(`${API_BASE}/images/${id}`, {
          method: "DELETE",
        });
      } catch (err) {
        console.error("Error deleting image:", err);
      }
    }, 1000);
  };

  const selectedImage = images.find((image) => image.id === selectedId);

  return (
    <main className="gallery-page" data-testid="gallery-page">
      <section className="gallery-shell">
        <header className="gallery-header">
          <div>
            <h1 data-testid="gallery-title">Image gallery</h1>

            <p data-testid="gallery-count">
              {images.length}{" "}
              {images.length === 1 ? "image" : "images"}
            </p>
          </div>

          <span
            className="shortcut-hint"
            data-testid="paste-hint"
          >
            Ctrl + V to paste
          </span>
        </header>

        <div
          className={`drop-zone${isDragging ? " is-dragging" : ""}`}
          data-testid="image-drop-zone"
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
          }}
          onDragLeave={() => {
            setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();

            setIsDragging(false);

            addFiles(event.dataTransfer.files);
          }}
        >
          <strong>Drop images here</strong>

          <span>or paste from your clipboard</span>

          <button
            type="button"
            className="browse-button"
            data-testid="browse-images-button"
            onClick={() => inputRef.current?.click()}
          >
            Browse files
          </button>

          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            data-testid="image-file-input"
            onChange={(event) => {
              addFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </div>

        {selectedImage && (
          <section
            className="preview-panel"
            data-testid="image-preview"
          >
            <div className="preview-heading">
              <span>Preview</span>

              <span
                className="preview-name"
                data-testid="preview-image-name"
              >
                {selectedImage.name}
              </span>
            </div>

            <img
              src={selectedImage.url}
              alt={selectedImage.name}
              data-testid="preview-image"
            />
          </section>
        )}

        {images.length > 0 ? (
          <section
            className="image-grid"
            data-testid="image-grid"
          >
            {images.map((image, index) => (
              <article
                className={`image-card${selectedId === image.id ? " is-selected" : ""
                  }`}
                key={image.id}
                data-testid={`image-card-${index}`}
              >
                <button
                  type="button"
                  className="image-select"
                  data-testid={`select-image-${index}`}
                  onClick={() => setSelectedId(image.id)}
                  aria-label={`Preview ${image.name}`}
                >
                  <img
                    src={image.url}
                    alt={image.name}
                  />
                </button>

                <div className="image-card-footer">
                  <span
                    title={image.name}
                    data-testid={`image-name-${index}`}
                  >
                    {image.name}
                  </span>

                  <button
                    type="button"
                    className="remove-button"
                    data-testid={`remove-image-${index}`}
                    onClick={() => removeImage(image.id)}
                    aria-label={`Remove ${image.name}`}
                  >
                    Remove
                  </button>
                </div>
              </article>
            ))}
          </section>
        ) : (
          <p
            className="empty-state"
            data-testid="empty-gallery-message"
          >
            Your gallery is empty.
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
