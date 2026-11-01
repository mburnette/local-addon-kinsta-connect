'use strict';

const path = require('path');

const createComponents = require('./renderer/components');

const NEW_SITE_ROUTE = '/main/kinsta-pull';

module.exports = function KinstaConnectRenderer(context) {
	const { React, ReactRouter, hooks } = context;
	const h = React.createElement;
	const { KinstaPanel, HeaderButtons, NewSitePage } = createComponents(context);

	hooks.addContent('stylesheets', () => h('link', {
		key: 'kinsta-connect-styles',
		rel: 'stylesheet',
		href: path.join(__dirname, 'renderer', 'styles.css'),
	}));

	// A "Kinsta" entry under the site's Tools tab: account connection, linking, and push/pull options.
	hooks.addFilter('siteInfoToolsItem', (items, { routeChildrenProps } = {}) => [
		...items,
		{
			path: '/kinsta-connect',
			menuItem: 'Kinsta',
			render: () => h(KinstaPanel, {
				site: routeChildrenProps && routeChildrenProps.site,
				siteStatus: routeChildrenProps && routeChildrenProps.siteStatus,
			}),
		},
	]);

	// "Kinsta: Pull / Push" buttons in the site header, next to Local Connect's own push/pull buttons.
	hooks.addContent('SiteInfo_Top_TopRight', (site, siteStatus) => h(HeaderButtons, {
		key: 'kinsta-connect-buttons',
		site,
		siteStatus,
	}));

	// "Pull from Kinsta" in Local's Create a site wizard. The option key is the route Continue navigates to.
	hooks.addFilter('CreateSite:RadioOptions', (options) => ({
		...options,
		[NEW_SITE_ROUTE.replace(/^\/main\//, '')]: {
			label: 'Pull from Kinsta',
			content: 'Create a new Local site from a Kinsta WordPress site, files and database.',
		},
	}));

	hooks.addContent('routes[main]', () => h(ReactRouter.Route, {
		key: 'kinsta-connect-new-site',
		path: NEW_SITE_ROUTE,
		render: ({ history }) => h(NewSitePage, { history }),
	}));
};
