#!/bin/sh
set -eu
exec /usr/bin/supervisord -n -c /etc/supervisor/conf.d/reva.conf
