import { CaptureController } from './captureController';

const controller = new CaptureController();
controller.start();

chrome.devtools.panels.create('Coveo', '', 'extension/panel.html', (panel) => {
	panel.onShown.addListener((panelWindow) => {
		panelWindow.__COVEO_DEVTOOLS_BRIDGE__ = controller.bridge;
		const readyEvent = panelWindow.document.createEvent('Event');
		readyEvent.initEvent('coveo-bridge-ready', false, false);
		panelWindow.dispatchEvent(readyEvent);
	});
});