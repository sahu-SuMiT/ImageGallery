import { useCallback, useEffect, useRef, useState } from "react";
import "./App.css";

const rawBackendUrl = (import.meta.env.VITE_BACKEND_URL || "").trim().replace(/\/+$/, "");
const API_BASE = rawBackendUrl
  ? (rawBackendUrl.endsWith("/api") ? rawBackendUrl : `${rawBackendUrl}/api`)
  : "/api";

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID?.trim() || "";

// Utility to decode Google JWT token client-side without extra dependencies
function parseJwt(token) {
  try {
    const base64Url = token.split(".")[1];
    const base64 = base64Url.replace(/-/g, "+").replace(/_/g, "/");
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join("")
    );
    return JSON.parse(jsonPayload);
  } catch (err) {
    console.error("JWT parse error:", err);
    return {};
  }
}

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

  // User state
  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem("gallery_google_user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const inputRef = useRef(null);
  const imagesRef = useRef([]);
  imagesRef.current = images;

  const googleBtnRef = useRef(null);
  const userRef = useRef(user);
  userRef.current = user;

  // Debounce refs to save network API calls from fast user insertions/deletions
  const pendingUploadItemsRef = useRef([]);
  const uploadDebounceTimerRef = useRef(null);

  const pendingDeleteIdsRef = useRef([]);
  const deleteDebounceTimerRef = useRef(null);

  // Initialize Google Identity Services
  useEffect(() => {
    const initGoogleGsi = () => {
      if (window.google?.accounts?.id && GOOGLE_CLIENT_ID && googleBtnRef.current) {
        try {
          window.google.accounts.id.initialize({
            client_id: GOOGLE_CLIENT_ID,
            callback: (response) => {
              if (response?.credential) {
                const payload = parseJwt(response.credential);
                const userData = {
                  token: response.credential,
                  id: payload.sub,
                  name: payload.name || "Google User",
                  email: payload.email,
                  picture: payload.picture,
                };
                setUser(userData);
                localStorage.setItem("gallery_google_user", JSON.stringify(userData));
              }
            },
          });

          window.google.accounts.id.renderButton(googleBtnRef.current, {
            theme: "outline",
            size: "medium",
            type: "standard",
            text: "signin_with",
            shape: "rectangular",
          });
        } catch (err) {
          console.warn("Google button render error:", err);
        }
      }
    };

    if (!user) {
      if (window.google) {
        initGoogleGsi();
      } else {
        const interval = setInterval(() => {
          if (window.google) {
            clearInterval(interval);
            initGoogleGsi();
          }
        }, 300);
        return () => clearInterval(interval);
      }
    }
  }, [user]);

  // Fetch images for current authenticated user
  const fetchImages = useCallback(async (authToken) => {
    if (!authToken) {
      setImages([]);
      setSelectedId(null);
      return;
    }

    try {
      const res = await fetch(`${API_BASE}/images`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data.images)) {
          setImages(data.images);
          setSelectedId((curr) => curr || (data.images.length ? data.images[0].id : null));
        }
      } else if (res.status === 401) {
        // Token expired
        setUser(null);
        localStorage.removeItem("gallery_google_user");
      }
    } catch (err) {
      console.warn("Could not load user images:", err);
    }
  }, []);

  useEffect(() => {
    if (user?.token) {
      fetchImages(user.token);
    } else {
      setImages([]);
      setSelectedId(null);
    }
  }, [user, fetchImages]);

  // Demo sign-in for testing user isolation before setting up Google Cloud Console
  const handleDemoSignIn = (demoName = "User 1") => {
    const demoToken = `demo_user_${demoName.toLowerCase().replace(/\s+/g, "_")}`;
    const userData = {
      token: demoToken,
      id: `demo_${demoName.toLowerCase().replace(/\s+/g, "_")}`,
      name: demoName,
      email: `${demoName.toLowerCase().replace(/\s+/g, "")}@example.com`,
      picture: null,
    };
    setUser(userData);
    localStorage.setItem("gallery_google_user", JSON.stringify(userData));
  };

  const handleSignOut = () => {
    setUser(null);
    localStorage.removeItem("gallery_google_user");
    setImages([]);
    setSelectedId(null);
  };

  // Send single debounced upload request for all fast insertions
  const flushDebouncedUpload = async () => {
    const itemsToUpload = [...pendingUploadItemsRef.current];
    pendingUploadItemsRef.current = [];

    if (!itemsToUpload.length) return;
    const currentUser = userRef.current;
    if (!currentUser?.token) return;

    const formData = new FormData();
    itemsToUpload.forEach((item) => {
      if (item.file) {
        formData.append("images", item.file, item.name);
      }
    });

    try {
      const res = await fetch(`${API_BASE}/images/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${currentUser.token}`,
        },
        body: formData,
      });

      if (res.ok) {
        const result = await res.json();
        const serverImages = result.images || [];

        // Replace temporary local blob URLs with permanent Cloudinary URLs
        setImages((current) => {
          let updated = [...current];
          itemsToUpload.forEach((localItem, index) => {
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
      console.error("Debounced upload failed:", err);
    }
  };

  // Send single debounced delete request for all fast deletions
  const flushDebouncedDelete = async () => {
    const idsToDelete = [...pendingDeleteIdsRef.current];
    pendingDeleteIdsRef.current = [];

    if (!idsToDelete.length) return;
    const currentUser = userRef.current;
    if (!currentUser?.token) return;

    try {
      await fetch(`${API_BASE}/images/batch-delete`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${currentUser.token}`,
        },
        body: JSON.stringify({ ids: idsToDelete }),
      });
    } catch (err) {
      console.error("Debounced delete failed:", err);
    }
  };

  // Fast user insertions: update UI instantly, debounce the API call by 0.5s
  const addFiles = useCallback((fileList) => {
    if (!userRef.current) {
      alert("Please sign in with Google to save images to your account.");
      return;
    }

    const newImages = Array.from(fileList || [])
      .filter((file) => file.type.startsWith("image/"))
      .map(createImage);

    if (!newImages.length) return;

    // 1. Instant UI update (0ms lag)
    setImages((current) => [...current, ...newImages]);
    setSelectedId((current) => current || newImages[0].id);

    // 2. Debounce network API call by 0.5s to batch rapid insertions into 1 API call
    pendingUploadItemsRef.current.push(...newImages);

    if (uploadDebounceTimerRef.current) {
      clearTimeout(uploadDebounceTimerRef.current);
    }

    uploadDebounceTimerRef.current = setTimeout(() => {
      uploadDebounceTimerRef.current = null;
      flushDebouncedUpload();
    }, 500);
  }, []);

  // Fast user deletions: update UI instantly, debounce the API call by 1.0s
  const removeImage = (id) => {
    // 1. Instant UI update (0ms lag)
    setImages((current) => {
      const image = current.find((item) => item.id === id);
      if (image && image.url?.startsWith("blob:")) {
        URL.revokeObjectURL(image.url);
      }
      return current.filter((item) => item.id !== id);
    });

    setSelectedId((current) => (current === id ? null : current));

    // If this image was pending upload in the 0.5s window, remove it to save the upload entirely!
    const wasPendingUpload = pendingUploadItemsRef.current.some(
      (item) => item.id === id
    );
    if (wasPendingUpload) {
      pendingUploadItemsRef.current = pendingUploadItemsRef.current.filter(
        (item) => item.id !== id
      );
      return;
    }

    // 2. Debounce network API call by 1.0s to batch rapid deletions into 1 API call
    if (!pendingDeleteIdsRef.current.includes(id)) {
      pendingDeleteIdsRef.current.push(id);
    }

    if (deleteDebounceTimerRef.current) {
      clearTimeout(deleteDebounceTimerRef.current);
    }

    deleteDebounceTimerRef.current = setTimeout(() => {
      deleteDebounceTimerRef.current = null;
      flushDebouncedDelete();
    }, 1000);
  };

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
      if (deleteDebounceTimerRef.current) {
        clearTimeout(deleteDebounceTimerRef.current);
      }
      imagesRef.current.forEach((image) => {
        if (image.url?.startsWith("blob:")) {
          URL.revokeObjectURL(image.url);
        }
      });
    };
  }, []);

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

          <div className="header-right">
            {user ? (
              <div className="user-profile">
                {user.picture && (
                  <img
                    src={user.picture}
                    alt={user.name}
                    className="user-avatar"
                  />
                )}
                <span className="user-name" title={user.email}>
                  {user.name}
                </span>
                <button
                  type="button"
                  className="signout-button"
                  onClick={handleSignOut}
                >
                  Sign out
                </button>
              </div>
            ) : (
              <div className="auth-container">
                {/* Official Google Sign-In Button */}
                <div ref={googleBtnRef}></div>

                {/* Instant Demo Switcher for fast local testing */}
                {!GOOGLE_CLIENT_ID && (
                  <>
                    <button
                      type="button"
                      className="demo-login-btn"
                      onClick={() => handleDemoSignIn("Sumit")}
                    >
                      Login as Sumit
                    </button>
                    <button
                      type="button"
                      className="demo-login-btn"
                      onClick={() => handleDemoSignIn("Alex")}
                    >
                      Login as Alex
                    </button>
                  </>
                )}
              </div>
            )}

            <span
              className="shortcut-hint"
              data-testid="paste-hint"
            >
              Ctrl + V to paste
            </span>
          </div>
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

          <span>
            {user
              ? "or paste from your clipboard"
              : "Sign in with Google to save images to your account"}
          </span>

          <button
            type="button"
            className="browse-button"
            data-testid="browse-images-button"
            onClick={() => {
              if (!user) {
                alert("Please sign in with Google first.");
                return;
              }
              inputRef.current?.click();
            }}
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
            {user
              ? "Your gallery is empty. Copy and paste an image to try it!"
              : "Please sign in with Google above to view and save your images."}
          </p>
        )}
      </section>
    </main>
  );
}

export default App;
