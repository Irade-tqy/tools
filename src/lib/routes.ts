export function appBase(pathname = location.pathname): string {
  return pathname.replace(/(?:chat|paste)\/?$/, '').replace(/\/?$/, '/');
}

export function routeUrl(route: string): string {
  return `${appBase()}${route}`;
}
