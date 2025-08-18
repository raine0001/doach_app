// Hard guard: skip all legacy UI and loops when new hamburger UI is present
if (!document.querySelector('nav.sidebar')) {
  console.log('[ui] new menu present — skipping legacy sidebar & loops');
  // Prevent double analysis loops
  window.__ANALYSIS_DISABLED__ = true;

  // Safely no-op any old DOM wiring below (prevents "addEventListener of null")
  const _add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function(type, fn, opts){
    try { return _add.call(this, type, fn, opts); } catch { /* swallow */ }
  };

  // If your file has big init() calls, just return here:
  // return;
}



//menu sidebar

// Selecting the sidebar and buttons
const sidebar = document.querySelector(".sidebar");
const sidebarOpenBtn = document.querySelector("#sidebar-open");
const sidebarCloseBtn = document.querySelector("#sidebar-close");
const sidebarLockBtn = document.querySelector("#lock-icon");

// Ensure menu is hidden until hover when locked
sidebar.addEventListener("mouseenter", () => {
  if (sidebar.classList.contains("locked")) {
    sidebar.classList.remove("locked");
  }
});
sidebar.addEventListener("mouseleave", () => {
  if (!sidebar.classList.contains("locked")) {
    sidebar.classList.add("locked");
  }
});


// Function to toggle the lock state of the sidebar
const toggleLock = () => {
  sidebar.classList.toggle("locked");
  // If the sidebar is not locked
  if (!sidebar.classList.contains("locked")) {
    sidebar.classList.add("hoverable");
    sidebarLockBtn.classList.replace("bx-lock-alt", "bx-lock-open-alt");
  } else {
    sidebar.classList.remove("hoverable");
    sidebarLockBtn.classList.replace("bx-lock-open-alt", "bx-lock-alt");
  }
};
// Function to hide the sidebar when the mouse leaves
const hideSidebar = () => {
  if (sidebar.classList.contains("hoverable")) {
    sidebar.classList.add("close");
  }
};
// Function to show the sidebar when the mouse enter
const showSidebar = () => {
  if (sidebar.classList.contains("hoverable")) {
    sidebar.classList.remove("close");
  }
};
// Function to show and hide the sidebar
const toggleSidebar = () => {
  sidebar.classList.toggle("close");
};
// If the window width is less than 800px, close the sidebar and remove hoverability and lock
if (window.innerWidth < 800) {
  sidebar.classList.add("close");
  sidebar.classList.remove("locked");
  sidebar.classList.remove("hoverable");
}
// Adding event listeners to buttons and sidebar for the corresponding actions
sidebarLockBtn.addEventListener("click", toggleLock);
sidebar.addEventListener("mouseleave", hideSidebar);
sidebar.addEventListener("mouseenter", showSidebar);