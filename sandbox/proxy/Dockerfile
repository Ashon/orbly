# The only external exit for sandbox containers. Lets through only allowlisted domains via CONNECT (443).
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY entrypoint.sh /usr/local/bin/proxy-entrypoint
RUN chmod 0755 /usr/local/bin/proxy-entrypoint
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/proxy-entrypoint"]
