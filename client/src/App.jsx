import React, { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useParams, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { FaArrowLeft, FaArrowRight, FaTimes, FaRandom, FaFolderOpen, FaRedo, FaSortAlphaDown, FaPlay } from 'react-icons/fa';

const API_URL = '/api';

function VideoThumbnail({ thumbUrl, label }) {
  return (
    <div style={{ position: 'relative', height: '200px', background: '#0f0f0f', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', overflow: 'hidden' }}>
      {thumbUrl ? (
        <img src={thumbUrl} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <FaPlay style={{ fontSize: '2rem', opacity: 0.8 }} />
      )}
      <FaPlay style={{ position: 'absolute', fontSize: '2rem', opacity: 0.9, pointerEvents: 'none' }} />
      <div style={{ position: 'absolute', bottom: '10px', left: '10px', right: '10px', fontSize: '0.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textShadow: '0 0 6px rgba(0,0,0,0.7)' }}>{label}</div>
    </div>
  );
}

function App() {
  const [homeState, setHomeState] = useState({
    folders: [],
    page: 1,
    hasMore: true,
    scrollPosition: 0
  });

  return (
    <Router>
      <div className="app">
        <Routes>
          <Route path="/" element={<Home savedState={homeState} setSavedState={setHomeState} />} />
          <Route path="/folder/:folderName" element={<FolderView />} />
          <Route path="/random" element={<RandomView />} />
        </Routes>
      </div>
    </Router>
  );
}

function Home({ savedState, setSavedState }) {
  const { folders, page, hasMore, scrollPosition, allFolders = [], sortOrder = 'random' } = savedState;
  const [loading, setLoading] = useState(false);
  const observer = useRef();
  
  // Restore and save scroll position
  useLayoutEffect(() => {
    const originalRestoration = window.history.scrollRestoration;
    if ('scrollRestoration' in window.history) {
      window.history.scrollRestoration = 'manual';
    }

    if (scrollPosition > 0) {
      window.scrollTo(0, scrollPosition);
    }

    return () => {
      // Save scroll position before unmounting
      const currentScroll = window.scrollY;
      setSavedState(prev => ({ ...prev, scrollPosition: currentScroll }));

      if ('scrollRestoration' in window.history) {
        window.history.scrollRestoration = originalRestoration;
      }
    };
  }, []);

  // Fetch all folders on mount if empty
  useEffect(() => {
    if (allFolders.length > 0) return;

    setLoading(true);
    axios.get(`${API_URL}/folders?limit=10000`).then(res => {
      let fetched = res.data.folders;
      
      // Initial Random Sort
      if (sortOrder === 'random') {
        for (let i = fetched.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [fetched[i], fetched[j]] = [fetched[j], fetched[i]];
        }
      } else {
         fetched.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
      }

      setSavedState(prev => ({
        ...prev,
        allFolders: fetched,
        folders: fetched.slice(0, 20),
        page: 1,
        hasMore: fetched.length > 20,
        sortOrder: sortOrder
      }));
      setLoading(false);
    });
  }, [allFolders.length]);

  const handleSort = (order) => {
    if (order === sortOrder) return;
    
    let newAll = [...allFolders];
    if (order === 'name') {
      newAll.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    } else {
      for (let i = newAll.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newAll[i], newAll[j]] = [newAll[j], newAll[i]];
      }
    }

    setSavedState(prev => ({
      ...prev,
      sortOrder: order,
      allFolders: newAll,
      folders: newAll.slice(0, 20),
      page: 1,
      hasMore: newAll.length > 20,
      scrollPosition: 0
    }));
    window.scrollTo(0, 0);
  };

  const lastFolderElementRef = useCallback(node => {
    if (loading) return;
    if (observer.current) observer.current.disconnect();
    observer.current = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && hasMore) {
        setSavedState(prev => {
          const nextPage = prev.page + 1;
          const nextFolders = prev.allFolders.slice(0, nextPage * 20);
          return {
            ...prev,
            page: nextPage,
            folders: nextFolders,
            hasMore: prev.allFolders.length > nextFolders.length
          };
        });
      }
    });
    if (node) observer.current.observe(node);
  }, [loading, hasMore, setSavedState]);

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Photo Folders</h1>
        <div style={{ display: 'flex', gap: '10px' }}>
          <button 
            className="nav-button" 
            style={{ position: 'static', transform: 'none', fontSize: '1rem', padding: '10px 20px', background: sortOrder === 'name' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}
            onClick={() => handleSort('name')}
          >
            <FaSortAlphaDown /> Name
          </button>
          <button 
            className="nav-button" 
            style={{ position: 'static', transform: 'none', fontSize: '1rem', padding: '10px 20px', background: sortOrder === 'random' ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.1)' }}
            onClick={() => handleSort('random')}
          >
            <FaRandom /> Random
          </button>
          <Link to="/random" className="nav-button" style={{ position: 'static', transform: 'none', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '10px', textDecoration: 'none' }}>
            <FaRandom /> Random Mode
          </Link>
        </div>
      </div>
      <div className="grid">
        {folders.map((folder, index) => {
          if (folders.length === index + 1) {
            return (
              <div ref={lastFolderElementRef} key={folder}>
                <Link to={`/folder/${folder}`} className="folder-card" style={{ textDecoration: 'none', color: 'white' }}>
                  <img 
                    src={`${API_URL}/thumbnail/${folder}`} 
                    alt={folder} 
                    className="thumbnail" 
                    loading="lazy"
                  />
                  <div className="folder-name">{folder}</div>
                </Link>
              </div>
            );
          } else {
            return (
              <Link to={`/folder/${folder}`} key={folder} className="folder-card" style={{ textDecoration: 'none', color: 'white' }}>
                <img 
                  src={`${API_URL}/thumbnail/${folder}`} 
                  alt={folder} 
                  className="thumbnail" 
                  loading="lazy"
                />
                <div className="folder-name">{folder}</div>
              </Link>
            );
          }
        })}
      </div>
      {loading && <div style={{ textAlign: 'center', padding: '20px' }}>Loading more folders...</div>}
    </div>
  );
}

function RandomView() {
  const [history, setHistory] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [queue, setQueue] = useState([]);
  const navigate = useNavigate();
  const fetchingRef = useRef(false);

  const fetchRandom = useCallback(async () => {
    try {
      const res = await axios.get(`${API_URL}/random-image`);
      return res.data;
    } catch (err) {
      console.error("Failed to fetch random image", err);
      return null;
    }
  }, []);

  // Initial load and queue maintenance
  useEffect(() => {
    const maintainQueue = async () => {
      if (fetchingRef.current) return;
      
      // If we have less than 5 items in queue, fetch more
      if (queue.length < 5) {
        fetchingRef.current = true;
        const needed = 5 - queue.length;
        const newItems = [];
        for (let i = 0; i < needed; i++) {
          const item = await fetchRandom();
          if (item) {
            newItems.push(item);
            // Preload image
            const img = new Image();
            img.src = `${API_URL}/image/${item.folder}/${item.image}`;
          }
        }
        
        if (newItems.length > 0) {
          setQueue(prev => [...prev, ...newItems]);
          
          // If this is the very first load
          if (currentIndex === -1 && history.length === 0) {
            setHistory([newItems[0]]);
            setCurrentIndex(0);
            setQueue(prev => prev.slice(1));
          }
        }
        fetchingRef.current = false;
      }
    };

    maintainQueue();
  }, [queue.length, fetchRandom, currentIndex, history.length]);

  const handleNext = async () => {
    if (currentIndex < history.length - 1) {
      // Just move forward in history
      setCurrentIndex(currentIndex + 1);
    } else {
      // Need new item from queue
      if (queue.length > 0) {
        const nextItem = queue[0];
        setHistory(prev => [...prev, nextItem]);
        setCurrentIndex(prev => prev + 1);
        setQueue(prev => prev.slice(1));
      } else {
        // Queue empty (shouldn't happen often due to preloading), fetch directly
        const data = await fetchRandom();
        if (data) {
          setHistory(prev => [...prev, data]);
          setCurrentIndex(prev => prev + 1);
        }
      }
    }
  };

  const handlePrev = () => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  };

  const handleExitRandom = () => {
    if (currentIndex >= 0) {
      const current = history[currentIndex];
      navigate(`/folder/${encodeURIComponent(current.folder)}`);
    } else {
      navigate('/');
    }
  };

  if (currentIndex === -1 || !history[currentIndex]) {
    return <div className="container">Loading...</div>;
  }

  const currentItem = history[currentIndex];

  return (
    <ImageViewer
      folderName={currentItem.folder}
      item={{ type: 'image', name: currentItem.image }}
      onClose={() => navigate('/')}
      onNext={handleNext}
      onPrev={handlePrev}
      isRandom={true}
      onExitRandom={handleExitRandom}
    />
  );
}

function FolderView() {
  const { folderName } = useParams();
  const [images, setImages] = useState([]);
  const [videos, setVideos] = useState([]);
  const [subFolders, setSubFolders] = useState([]);
  const [selectedIndex, setSelectedIndex] = useState(null);

  useEffect(() => {
    // folderName is encoded by react-router, but we might need to double check
    // if it contains slashes, it should be fine as part of the URL path if encoded
    // But here we are using it as a segment.
    // If folderName is "A/B", the URL is /api/folders/A%2FB
    // axios will send /api/folders/A/B which matches our wildcard route
    axios.get(`${API_URL}/folders/${encodeURIComponent(folderName)}`).then(res => {
      setImages(res.data.images || []);
      setVideos(res.data.videos || []);
      setSubFolders(res.data.folders || []);
    });
  }, [folderName]);

  const openViewer = (index) => {
    setSelectedIndex(index);
  };

  const closeViewer = () => {
    setSelectedIndex(null);
  };

  const mediaItems = [
    ...images.map(name => ({ type: 'image', name })),
    ...videos.map(name => ({ type: 'video', name })),
  ];

  const nextMedia = useCallback(() => {
    setSelectedIndex(prev => (prev + 1) % mediaItems.length);
  }, [mediaItems.length]);

  const prevMedia = useCallback(() => {
    setSelectedIndex(prev => (prev - 1 + mediaItems.length) % mediaItems.length);
  }, [mediaItems.length]);

  return (
    <div className="container">
      <Link to="/" style={{ color: 'white', textDecoration: 'none', display: 'inline-block', marginBottom: '20px' }}>&larr; Back to Folders</Link>
      <h1>{folderName}</h1>
      
      {subFolders.length > 0 && (
        <div className="grid" style={{ marginBottom: '40px' }}>
          {subFolders.map(sub => (
            <Link to={`/folder/${encodeURIComponent(folderName + '/' + sub)}`} key={sub} className="folder-card" style={{ textDecoration: 'none', color: 'white' }}>
              <img 
                src={`${API_URL}/thumbnail/${encodeURIComponent(folderName + '/' + sub)}`} 
                alt={sub} 
                className="thumbnail" 
                loading="lazy"
              />
              <div className="folder-name">{sub}</div>
            </Link>
          ))}
        </div>
      )}

      <div className="grid">
        {mediaItems.map((item, index) => (
          <div key={`${item.type}-${item.name}`} className="photo-card" onClick={() => openViewer(index)}>
            {item.type === 'image' ? (
              <img 
                src={`${API_URL}/image/${encodeURIComponent(folderName + '/' + item.name)}?width=300`} 
                alt={item.name} 
                className="thumbnail" 
                loading="lazy"
              />
            ) : (
              <VideoThumbnail 
                thumbUrl={`${API_URL}/video-thumbnail/${encodeURIComponent(folderName + '/' + item.name)}`}
                label={item.name}
              />
            )}
          </div>
        ))}
      </div>

      {selectedIndex !== null && mediaItems.length > 0 && (
        <ImageViewer 
          folderName={folderName}
          item={mediaItems[selectedIndex]}
          onClose={closeViewer}
          onNext={nextMedia}
          onPrev={prevMedia}
        />
      )}
    </div>
  );
}

function ImageViewer({ folderName, item, onClose, onNext, onPrev, isRandom, onExitRandom }) {
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [startPos, setStartPos] = useState({ x: 0, y: 0 });
  const [isLoaded, setIsLoaded] = useState(false);
  const [imageVersion, setImageVersion] = useState(0);
  const [rotating, setRotating] = useState(false);
  const isVideo = item?.type === 'video';
  const mediaName = item?.name;

  // Touch handling refs
  const touchStart = useRef(null);
  const lastTapTime = useRef(0);
  const initialPinchDistance = useRef(null);
  const initialScale = useRef(1);
  const imgRef = useRef(null);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowRight') onNext();
      if (e.key === 'ArrowLeft') onPrev();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNext, onPrev]);

  // Reset zoom/pan when media changes
  useEffect(() => {
    setScale(1);
    setPosition({ x: 0, y: 0 });
    setIsLoaded(false);
    setImageVersion(0);
  }, [mediaName, isVideo]);

  const handleWheel = (e) => {
    if (isVideo) return;
    e.preventDefault();
    const scaleAdjustment = -e.deltaY * 0.001;
    setScale(prev => Math.min(Math.max(0.5, prev + scaleAdjustment), 5));
  };

  const handleMouseDown = (e) => {
    if (isVideo) return;
    setIsDragging(true);
    setStartPos({ x: e.clientX - position.x, y: e.clientY - position.y });
  };

  const handleMouseMove = (e) => {
    if (isVideo) return;
    if (!isDragging) return;
    setPosition({ x: e.clientX - startPos.x, y: e.clientY - startPos.y });
  };

  const handleMouseUp = () => {
    if (isVideo) return;
    setIsDragging(false);
  };

  const getDistance = (touches) => {
    return Math.hypot(
      touches[0].clientX - touches[1].clientX,
      touches[0].clientY - touches[1].clientY
    );
  };

  const handleTouchStart = (e) => {
    if (isVideo) return;
    if (e.touches.length === 1) {
      touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, time: Date.now() };
      if (scale > 1) {
        setIsDragging(true);
        setStartPos({ x: e.touches[0].clientX - position.x, y: e.touches[0].clientY - position.y });
      }
    } else if (e.touches.length === 2) {
      initialPinchDistance.current = getDistance(e.touches);
      initialScale.current = scale;
    }
  };

  const handleTouchMove = (e) => {
    if (isVideo) return;
    // Prevent default browser behavior (scrolling/zooming)
    // Note: This might require the event listener to be non-passive, 
    // but React's synthetic events are usually fine if we use touch-action: none in CSS
    
    if (e.touches.length === 1) {
      if (scale > 1 && isDragging) {
         // Prevent scrolling while dragging image
         e.preventDefault(); 
         setPosition({ 
           x: e.touches[0].clientX - startPos.x, 
           y: e.touches[0].clientY - startPos.y 
         });
      }
    } else if (e.touches.length === 2 && initialPinchDistance.current) {
      // Prevent browser zoom
      e.preventDefault();
      const currentDistance = getDistance(e.touches);
      const newScale = initialScale.current * (currentDistance / initialPinchDistance.current);
      setScale(Math.min(Math.max(0.5, newScale), 5));
    }
  };

  const handleZoomToPoint = (clientX, clientY) => {
    if (isVideo) return;
    if (scale < 1.1) {
      let newScale = 2.5;
      if (imgRef.current && imgRef.current.width > 0) {
        const { naturalWidth, width } = imgRef.current;
        newScale = naturalWidth / width;
        if (newScale < 1.01) newScale = 2.5;
      }

      // Calculate zoom center
      let targetX = clientX;
      let targetY = clientY;

      // Clamp click position to image bounds
      if (imgRef.current) {
         const rect = imgRef.current.getBoundingClientRect();
         targetX = Math.max(rect.left, Math.min(targetX, rect.right));
         targetY = Math.max(rect.top, Math.min(targetY, rect.bottom));
      }

      const centerX = window.innerWidth / 2;
      const centerY = window.innerHeight / 2;
      const dx = targetX - centerX;
      const dy = targetY - centerY;

      setScale(newScale);
      setPosition({ x: -dx * newScale, y: -dy * newScale });
    } else {
      setScale(1);
      setPosition({ x: 0, y: 0 });
    }
  };

  const handleTouchEnd = (e) => {
    if (isVideo) return;
    if (e.changedTouches.length === 1 && touchStart.current) {
       const touchEnd = { x: e.changedTouches[0].clientX, y: e.changedTouches[0].clientY };
       const deltaX = touchEnd.x - touchStart.current.x;
       const deltaY = touchEnd.y - touchStart.current.y;
       const timeDiff = Date.now() - touchStart.current.time;
       const dist = Math.hypot(deltaX, deltaY);

       // Swipe detection (threshold 50px, max vertical 100px, max time 500ms)
       if (scale < 1.1 && Math.abs(deltaX) > 50 && Math.abs(deltaY) < 100 && timeDiff < 500) {
         if (deltaX > 0) {
           onPrev();
         } else {
           onNext();
         }
       } else if (dist < 10) {
         // Tap detection
         const currentTime = Date.now();
         const tapLength = currentTime - lastTapTime.current;
         if (tapLength < 300 && tapLength > 0) {
           // Double tap
           handleZoomToPoint(touchEnd.x, touchEnd.y);
           lastTapTime.current = 0;
         } else {
           lastTapTime.current = currentTime;
         }
       }
    }
    
    if (e.touches.length < 2) {
      initialPinchDistance.current = null;
    }
    if (e.touches.length === 0) {
        setIsDragging(false);
    }
  };

  const handleDoubleClick = (e) => {
    handleZoomToPoint(e.clientX, e.clientY);
  };

  const handleRotate = async (e) => {
    if (isVideo) return;
    e.stopPropagation();
    if (rotating) return;
    setRotating(true);
    try {
      // folderName might be a path like "A/B"
      // imageName is just the filename like "img.jpg"
      // The server expects folderName to be the path relative to PHOTOS_DIR
      await axios.post(`${API_URL}/rotate`, { folderName, imageName: mediaName });
      setImageVersion(v => v + 1);
    } catch (err) {
      console.error("Failed to rotate", err);
      alert("Failed to rotate image");
    } finally {
      setRotating(false);
    }
  };

  // We need to encode the path components for the URL
  const fullPath = encodeURIComponent(folderName + '/' + mediaName);
  const fullMediaUrl = isVideo 
    ? `${API_URL}/video/${fullPath}`
    : `${API_URL}/image/${fullPath}?v=${imageVersion}`;
  const previewImageUrl = isVideo 
    ? null 
    : `${API_URL}/image/${fullPath}?width=300&v=${imageVersion}`;

  const isConverted = /\.(heic|heif|dng)$/i.test(mediaName);

  return (
    <div className="full-screen-viewer">
      <button className="close-button" onClick={onClose}><FaTimes /></button>
      <button className="nav-button prev-button" onClick={(e) => { e.stopPropagation(); onPrev(); }}><FaArrowLeft /></button>
      
      {isRandom && (
        <button 
          className="nav-button" 
          style={{ top: '20px', left: '20px', transform: 'none', fontSize: '1rem', display: 'flex', alignItems: 'center', gap: '10px' }}
          onClick={(e) => { e.stopPropagation(); onExitRandom(); }}
        >
          <FaFolderOpen /> Show Folder
        </button>
      )}

      {!isVideo && (
        <button 
          className="nav-button" 
          style={{ top: '20px', right: '80px', transform: 'none', fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}
          onClick={handleRotate}
          disabled={rotating}
        >
          <FaRedo style={{ animation: rotating ? 'spin 1s linear infinite' : 'none' }} />
        </button>
      )}

      <div style={{
        position: 'absolute',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.5)',
        padding: '10px 20px',
        borderRadius: '20px',
        zIndex: 1002,
        pointerEvents: 'none',
        textAlign: 'center'
      }}>
        <div>{isRandom ? folderName : mediaName}</div>
        {isRandom && <div style={{ fontSize: '0.8em', opacity: 0.8 }}>{mediaName}</div>}
      </div>

      <div style={{
        position: 'absolute',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: 'rgba(0,0,0,0.5)',
        padding: '10px 20px',
        borderRadius: '20px',
        zIndex: 1002,
        display: 'flex',
        gap: '15px',
        alignItems: 'center'
      }}>
        <span>{mediaName}</span>
        {isConverted && (
          <a 
            href={`${API_URL}/original/${fullPath}`} 
            target="_blank" 
            rel="noopener noreferrer"
            style={{ color: '#4da6ff', textDecoration: 'none', fontWeight: 'bold' }}
            onClick={(e) => e.stopPropagation()}
          >
            Open Original
          </a>
        )}
      </div>

      <div 
        style={{ 
          width: '100%', 
          height: '100%', 
          display: 'flex', 
          justifyContent: 'center', 
          alignItems: 'center',
          overflow: 'hidden',
          position: 'relative',
          touchAction: 'none' // Disable browser handling of gestures
        }}
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={handleDoubleClick}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {isVideo ? (
          <video 
            src={fullMediaUrl}
            controls
            style={{ maxWidth: '100%', maxHeight: '100%' }}
            autoPlay
          />
        ) : (
          <>
            {/* Low res placeholder */}
            {!isLoaded && previewImageUrl && (
              <img 
                src={previewImageUrl} 
                alt={mediaName} 
                className="full-image"
                style={{ 
                  transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                  position: 'absolute',
                  filter: 'blur(10px)',
                  opacity: 0.5
                }}
                draggable={false}
              />
            )}

            {/* Full res image */}
            <img 
              ref={imgRef}
              src={fullMediaUrl} 
              alt={mediaName} 
              className="full-image"
              style={{ 
                transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                cursor: isDragging ? 'grabbing' : 'grab',
                opacity: isLoaded ? 1 : 0,
                transition: 'opacity 0.3s ease-in'
              }}
              draggable={false}
              onLoad={() => setIsLoaded(true)}
            />
          </>
        )}
      </div>

      <button className="nav-button next-button" onClick={(e) => { e.stopPropagation(); onNext(); }}><FaArrowRight /></button>
    </div>
  );
}

export default App;
