# The counter-example, and the only reason it exists is that a search which finds nothing
# proves nothing.
#
# `npm run demo:image` builds this beside the real image, hands it the same token, and
# runs the same three searches over it. The real image must answer zero in all three
# places and this one must not — a demo whose measurement cannot fail is a demo that
# would pass with the search broken.
#
# Both careless channels, in four lines:
#
#   ARG   — substituted into the TEXT of the RUN below, which is recorded in the image's
#           history and config for ever. Deleting the file afterwards cleans a filesystem;
#           metadata is not a filesystem.
#   COPY-shaped write + rm — the bytes land in one layer and the removal adds a whiteout
#           in the next. The final filesystem shows no file and the layer underneath still
#           carries every byte of it.
FROM busybox:1.37.0
ARG NPM_TOKEN
RUN printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > /root/.npmrc
RUN rm -f /root/.npmrc
CMD ["true"]
