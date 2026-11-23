import { useEffect, useMemo, useState } from "react";
import type { MediaAsset, Project } from "../../types/studio";
import {
  computeProjectThumbnailFingerprint,
  getOrCreateProjectThumbnail,
  renderFallbackProjectThumbnailDataUrl,
} from "../../utils/projectThumbnails";

interface ProjectThumbnailProps {
  project: Project;
  mediaAssets: MediaAsset[];
  className?: string;
}

export function ProjectThumbnail({
  project,
  mediaAssets,
  className = "h-full w-full object-cover",
}: ProjectThumbnailProps) {
  const fingerprint = useMemo(
    () => computeProjectThumbnailFingerprint(project, mediaAssets),
    [project, mediaAssets]
  );

  const fallbackUrl = useMemo(
    () => renderFallbackProjectThumbnailDataUrl(project),
    [project]
  );

  const [thumbUrl, setThumbUrl] = useState<string>(fallbackUrl);

  useEffect(() => {
    let active = true;
    void getOrCreateProjectThumbnail(project, mediaAssets)
      .then((res) => {
        if (active && res.url) {
          setThumbUrl(res.url);
        }
      })
      .catch(() => {
        if (active) {
          setThumbUrl(fallbackUrl);
        }
      });

    return () => {
      active = false;
    };
  }, [fingerprint, project, mediaAssets, fallbackUrl]);

  return (
    <img
      src={thumbUrl || fallbackUrl}
      alt={project.name}
      loading="lazy"
      decoding="async"
      className={className}
    />
  );
}
