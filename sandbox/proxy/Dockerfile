# 샌드박스 컨테이너의 유일한 외부 출구. 허용 목록의 도메인만 CONNECT(443)로 통과시킨다.
FROM alpine:3.22
RUN apk add --no-cache tinyproxy
COPY tinyproxy.conf /etc/tinyproxy/tinyproxy.conf
COPY entrypoint.sh /usr/local/bin/proxy-entrypoint
RUN chmod 0755 /usr/local/bin/proxy-entrypoint
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/proxy-entrypoint"]
