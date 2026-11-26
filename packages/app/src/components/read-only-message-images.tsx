import { useCallback, useMemo, useState } from "react";
import { Image, View, type StyleProp, type ViewStyle } from "react-native";
import { useFetchQuery } from "@/data/query";
import type { MessageImageAttachment } from "@getpaseo/protocol/agent-types";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AttachmentLightbox, type ImageLightboxSource } from "@/components/attachment-lightbox";
import { AttachmentFrame, AttachmentThumbnail } from "@/components/attachment-pill";
import type { UserMessageImageAttachment } from "@/types/stream";

export interface MessageImageReader {
  serverId: string;
  workspaceId: string;
  read: (image: MessageImageAttachment) => Promise<string>;
}

function RemoteMessageImage({
  image,
  reader,
  label,
  onOpen,
}: {
  image: MessageImageAttachment;
  reader: MessageImageReader | undefined;
  label: string;
  onOpen: (source: ImageLightboxSource) => void;
}) {
  const { data: uri } = useFetchQuery({
    queryKey: ["message-image", reader?.serverId, reader?.workspaceId, image.id],
    enabled: Boolean(reader),
    queryFn: () => reader!.read(image),
    dataShape: "value",
    immutableWhen: Boolean,
    gcTime: 0,
    retry: false,
  });
  const source = useMemo(() => (uri ? { uri } : null), [uri]);
  const open = useCallback(() => {
    if (uri) onOpen({ type: "uri", uri });
  }, [onOpen, uri]);

  return (
    <AttachmentFrame onPress={uri ? open : undefined} accessibilityLabel={label}>
      {source ? (
        <Image source={source} style={styles.thumbnail} />
      ) : (
        <View style={styles.placeholder} />
      )}
    </AttachmentFrame>
  );
}

function MessageImage({
  image,
  label,
  onOpen,
}: {
  image: UserMessageImageAttachment;
  label: string;
  onOpen: (source: ImageLightboxSource) => void;
}) {
  const open = useCallback(() => onOpen({ type: "attachment", metadata: image }), [image, onOpen]);
  return (
    <AttachmentFrame onPress={open} accessibilityLabel={label}>
      <AttachmentThumbnail metadata={image} />
    </AttachmentFrame>
  );
}

export function ReadOnlyMessageImages({
  images,
  imageAttachments,
  imageReader,
  style,
}: {
  images?: readonly UserMessageImageAttachment[];
  imageAttachments?: readonly MessageImageAttachment[];
  imageReader?: MessageImageReader;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTranslation();
  const [source, setSource] = useState<ImageLightboxSource | null>(null);
  const close = useCallback(() => setSource(null), []);
  const label = t("composer.attachments.openImage");

  return (
    <>
      <View style={[styles.images, style]}>
        {images?.map((image) => (
          <MessageImage key={image.id} image={image} label={label} onOpen={setSource} />
        ))}
        {!images?.length
          ? imageAttachments?.map((image) => (
              <RemoteMessageImage
                key={image.id}
                image={image}
                reader={imageReader}
                label={label}
                onOpen={setSource}
              />
            ))
          : null}
      </View>
      {source ? <AttachmentLightbox source={source} onClose={close} /> : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  thumbnail: { width: 48, height: 48 },
  placeholder: { width: 48, height: 48, backgroundColor: theme.colors.surface1 },
  images: {
    flexDirection: "row",
    gap: theme.spacing[2],
    flexWrap: "wrap",
  },
}));
