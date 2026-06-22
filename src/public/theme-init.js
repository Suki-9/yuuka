(function () {
	try {
		var t = localStorage.getItem("yuuka-theme") || "dark";
		document.documentElement.setAttribute("data-theme", t);
		document.documentElement.classList.add("theme-no-transition");
		var colors = {
			dark: "#121212",
			light: "#FAFAFA",
			"blue-archive": "#FBFCFF",
		};
		var m = document.querySelector('meta[name="theme-color"]');
		if (m) m.setAttribute("content", colors[t] || colors.dark);
	} catch (e) {}
})();
