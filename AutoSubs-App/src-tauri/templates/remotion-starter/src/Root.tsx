import { Composition } from "remotion";
import { Scene } from "./Scene";

// One composition per motion graphic. render_motion renders the one named
// "Main" unless told otherwise. Length = durationInFrames / fps seconds.
export const RemotionRoot = () => (
  <Composition
    id="Main"
    component={Scene}
    durationInFrames={150}
    fps={30}
    width={1920}
    height={1080}
    defaultProps={{ title: "Your Title", subtitle: "A short subtitle" }}
  />
);
