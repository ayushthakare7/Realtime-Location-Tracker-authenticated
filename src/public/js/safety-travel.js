const token = localStorage.getItem("token");
if (!token) window.location.replace("/login");

const form = document.getElementById("journeyForm");
const feedback = document.getElementById("journeyFeedback");

form.addEventListener("submit", event => {
  event.preventDefault();
  feedback.textContent = "The Safety Travel page is ready, but journey planning is not connected to the routing and journey backend yet. Your request has not been sent or saved. Once that service is implemented, Reva will clarify missing details, show real route options, and ask you to approve a route before monitoring begins.";
  feedback.classList.add("visible");
});
