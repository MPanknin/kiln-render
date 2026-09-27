// Gallery tiles. Adding a dataset is one entry here — no page-to-page sync.
// Links are RELATIVE (app/… , app/multichannel/…) so they resolve under the
// production root, branch previews, and the private remote alike. Keep them
// relative — don't reintroduce absolute mpanknin.github.io URLs.
//
// Dataset descriptions + source citations were merged in from the old
// docs/examples.md (removed 2026-07-08); the credits block also lives at the
// bottom of docs/gallery.md. This is the single source of truth for tiles.

export interface GallerySource {
  label: string;
  url: string;
}

export interface GalleryItem {
  title: string;
  meta: string;
  href: string;
  /** Thumbnail image URL; omit to show the dimensions placeholder instead. */
  thumb?: string;
  alt?: string;
  /** Shown in place of a missing thumbnail. */
  placeholder?: string;
  /** One-line scientific description. */
  description?: string;
  /** Attribution / provenance link. */
  source?: GallerySource;
}

const SCIVIS = 'https://github.com/InsightSoftwareConsortium/OMEZarrOpenSciVisDatasets';

export const gallery: GalleryItem[] = [
  {
    title: 'Veiled chameleon',
    meta: 'CT · 16-bit · 2.2 GB · 1024 × 1024 × 1080',
    href: 'app/?mode=dvr&wc=0.35&ww=0.55&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=0.070%2C3.630%2C1.497%2C0.108%2C0.001%2C-0.066',
    thumb: 'gallery/chameleon.webp',
    alt: 'Veiled chameleon CT scan',
    description:
      'CT scan of Chamaeleo calyptratus. DVR mode with a grayscale transfer function and window/level tuned for soft-tissue contrast.',
    source: { label: 'Open SciVis — Chameleon', url: `${SCIVIS}#chameleon` },
  },
  {
    title: 'Woodbranch',
    meta: 'µCT · 16-bit · 16.0 GB · 2048³',
    href: 'app/?dataset=https%3A%2F%2Fome-zarr-scivis.s3.us-east-1.amazonaws.com%2Fv0.5%2F96x2%2Fwoodbranch.ome.zarr&mode=dvr&wc=0.06&ww=0.13&iso=0.20&tf=grayscale&up=-y&scale=0.50&cam=0.540%2C3.870%2C1.488%2C0.016%2C-0.003%2C-0.008',
    thumb: 'gallery/woodbranch.webp',
    alt: 'Woodbranch micro-CT scan',
    description:
      'Micro-CT of a wood branch, streamed directly from an OME-Zarr v0.5 store on S3. Shown in DVR mode.',
    source: { label: 'Open SciVis Datasets', url: SCIVIS },
  },
  {
    title: 'Beechnut',
    meta: 'µCT · 16-bit · 3.0 GB · 1024 × 1024 × 1546',
    href: 'app/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fbeechnut.ome.zarr&mode=dvr&wc=0.22&ww=0.14&iso=0.20&tf=grayscale&up=-y&scale=0.5&cam=-0.090%2C2.130%2C3.171%2C-0.072%2C-0.025%2C-0.013',
    thumb: 'gallery/beechnut.webp',
    alt: 'Beechnut micro-CT scan',
    description:
      'MicroCT of a dried beechnut, streamed from an OME-Zarr v0.5 store. Shown in DVR mode.',
    source: { label: 'Open SciVis — Beechnut', url: `${SCIVIS}#beechnut` },
  },
  {
    title: 'Backpack',
    meta: 'CT · 16-bit · 187 MB · 512 × 512 × 373',
    href: 'app/?dataset=https%3A%2F%2Fome-zarr-scivis.s3.us-east-1.amazonaws.com%2Fv0.5%2F96x2%2Fbackpack.ome.zarr&mode=dvr&wc=0.03&ww=0.07&density=1.00&iso=0.20&tf=coolwarm&tfpts=0.00%2C0.00%2C0.25%2C0.00%2C1.00%2C1.00&up=-y&scale=0.50&cam=0.200%2C3.620%2C1.351%2C0.018%2C0.113%2C-0.037',
    thumb: 'gallery/backpack.webp',
    alt: 'Backpack CT scan',
    description: 'CT scan from the Open SciVis collection, shown in DVR mode with a cool-warm transfer function.',
    source: { label: 'Open SciVis Datasets', url: SCIVIS },
  },
  {
    title: 'Kingsnake',
    meta: 'CT · 8-bit · 795 MB · 1024 × 1024 × 795',
    href: 'app/?dataset=https%3A%2F%2Fome-zarr-scivis.s3.us-east-1.amazonaws.com%2Fv0.5%2F96x2%2Fkingsnake.ome.zarr&mode=mip&wc=0.39&ww=0.37&density=1.00&iso=0.48&tf=hot&tfpts=0.00%2C0.00%2C0.25%2C0.00%2C1.00%2C1.00&up=y&scale=0.50&cam=0.240%2C-0.940%2C0.838%2C0.041%2C0.016%2C0.114',
    thumb: 'gallery/kingsnake.webp',
    alt: 'Kingsnake CT scan',
    description: 'CT scan from the Open SciVis collection, shown in MIP mode.',
    source: { label: 'Open SciVis Datasets', url: SCIVIS },
  },
  {
    title: 'Pawpawsaurus',
    meta: 'CT · 16-bit · 1.3 GB · 958 × 646 × 1088',
    href: 'app/?dataset=https%3A%2F%2Fome-zarr-scivis.s3.us-east-1.amazonaws.com%2Fv0.5%2F96x2%2Fpawpawsaurus.ome.zarr&mode=iso&wc=0.46&ww=0.56&density=1.00&iso=0.20&tf=viridis&tfpts=0.00%2C0.00%2C0.25%2C0.00%2C1.00%2C1.00&up=-y&scale=0.50&cam=0.470%2C2.590%2C1.679%2C-0.034%2C0.049%2C0.076',
    thumb: 'gallery/pawpawsaurus.webp',
    alt: 'Pawpawsaurus skull CT scan',
    description: 'CT scan of a Pawpawsaurus skull from the Open SciVis collection, shown in isosurface mode.',
    source: { label: 'Open SciVis Datasets', url: SCIVIS },
  },
  {
    title: 'Vibrio cholerae',
    meta: 'Cryo-ET · 32-bit · 1.1 GB · 1023 × 1440 × 400',
    href: 'app/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fsma2022-07-13-10.zarr&mode=dvr&wc=0.50&ww=1.00&iso=0.20&tf=grayscale-inverted&tfpts=0.00%2C1.00%2C1.00%2C1.00&up=-z&scale=0.50&cam=0.550%2C12.050%2C1.203%2C0.046%2C0.017%2C0.146&clipMin=0.00%2C0.00%2C0.37&wireframe=1',
    thumb: 'gallery/cryo.webp',
    alt: 'Vibrio cholerae cryo-ET tomogram',
    description:
      'Cryo-ET tomogram from the CryoET Data Portal. DVR mode with an inverted grayscale transfer function and Z-axis clipping to isolate a region of interest.',
    source: {
      label: 'CryoET Data Portal',
      url: 'https://cryoetdataportal.czscience.com/runs/33757?table-tab=Tomograms',
    },
  },
  // {
  //   title: 'Zebrafish lateral line',
  //   meta: 'Fluorescence · 8-bit · 2 channels · 1584 × 788 × 142',
  //   href: 'app/multichannel/?dataset=https%3A%2F%2Flivingobjects.ebi.ac.uk%2Fidr%2Fzarr%2Fv0.4%2Fidr0079A%2Fidr0079_images.zarr&up=-z&mode=mip&scale=0.50&cam=0.450%2C0.770%2C1.144%2C0.031%2C-0.021%2C0.070&channels=0%2C0%2C255%2C1.00%2C1%2C0.02%2C0.46%3B255%2C255%2C0%2C1.00%2C1%2C0.01%2C0.38&slice=792%2C394%2C71%2C1%2C1%2C1',
  //   thumb: 'gallery/zebrafish.webp',
  //   alt: 'Zebrafish lateral line, 2-channel fluorescence',
  //   description:
  //     'AiryScan confocal fluorescence of the zebrafish posterior lateral line primordium. lynEGFP (membrane) + NLStdTomato (nuclear). Shown in MIP mode.',
  //   source: { label: 'IDR0079 · Hartmann et al., 2020', url: 'https://doi.org/10.7554/eLife.55913' },
  // },
  // {
  //   title: 'Human fibroblast (IDR0101)',
  //   meta: 'Fluorescence · 16-bit · 4 channels · 2048 × 2048 × 35',
  //   href: 'app/multichannel/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fmultichannel%2F13457227.zarr%2F13457227.zarr&up=-y&mode=mip&scale=0.50&cam=-0.430%2C3.140%2C1.276%2C-0.001%2C0.048%2C0.022&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.01%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.02&slice=1024%2C1024%2C18%2C1%2C1%2C1',
  //   thumb: 'gallery/fibroplast.webp',
  //   alt: 'Human fibroblast, 4-channel in situ genome sequencing',
  //   description:
  //     'Confocal microscopy of human fibroblasts (PGP1) from an in situ genome sequencing study. Four channels across 35 z-slices, shown in MIP mode.',
  //   source: { label: 'IDR0101 · Payne et al., 2021', url: 'https://doi.org/10.1126/science.aay3446' },
  // },
  // {
  //   title: 'Zebrafish embryo · IM2',
  //   meta: 'Fluorescence · 16-bit · 4 channels · 512 × 512 × 94',
  //   href: 'app/multichannel/?dataset=https%3A%2F%2Fuk1s3.embassy.ebi.ac.uk%2Fbia-integrator-data%2FS-BSST410%2FIM2%2FIM2.zarr%2F0&up=-z&mode=mip&scale=0.50&cam=0.550%2C1.400%2C1.691%2C0.002%2C0.059%2C0.083&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.06%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.03%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.03&slice=256%2C256%2C47%2C1%2C1%2C1',
  //   thumb: 'gallery/zebrafish-embryo-im2.webp',
  //   alt: 'Zebrafish embryo, 4-channel fluorescence',
  //   description:
  //     'Four-channel fluorescence of a zebrafish (Danio rerio) embryo, from a study of axis specification and pattern formation. Shown in MIP mode.',
  //   source: { label: 'BioImage Archive · S-BSST410 (IM2)', url: 'https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/pages/S-BSST410/IM2.html' },
  // },
  {
    title: 'Zebrafish embryo · IM4',
    meta: 'Fluorescence · 16-bit · 4 channels · 512 × 512 × 103',
    href: 'app/multichannel/?dataset=https%3A%2F%2Fuk1s3.embassy.ebi.ac.uk%2Fbia-integrator-data%2FS-BSST410%2FIM4%2FIM4.zarr%2F0&up=-z&mode=mip&scale=0.50&cam=0.740%2C2.700%2C1.489%2C0.003%2C0.039%2C0.037&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.06%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.01%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.02&slice=256%2C256%2C52%2C1%2C1%2C1',
    thumb: 'gallery/zebrafish-embryo-im4.webp',
    alt: 'Zebrafish embryo, 4-channel fluorescence',
    description:
      'Four-channel fluorescence of a zebrafish embryo. Shown in MIP mode.',
    source: { label: 'BioImage Archive · S-BSST410 (IM4)', url: 'https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/pages/S-BSST410/IM4.html' },
  },
  // {
  //   title: 'Arabidopsis FLC · IM1',
  //   meta: 'Fluorescence · 16-bit · 2 channels · 968 × 728 × 45',
  //   href: 'app/multichannel/?dataset=https%3A%2F%2Fuk1s3.embassy.ebi.ac.uk%2Fbia-integrator-data%2FS-BIAD425%2FIM1%2FIM1.zarr%2F0&up=-z&mode=mip&scale=0.50&cam=0.880%2C1.410%2C1.601%2C-0.000%2C0.033%2C0.039&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.18%3B255%2C255%2C0%2C1.00%2C1%2C0.03%2C0.23&slice=484%2C364%2C23%2C1%2C1%2C1',
  //   thumb: 'gallery/arabidopsis-flc-im1.webp',
  //   alt: 'Arabidopsis FLC smFISH, DAPI + Cy3',
  //   description:
  //     'Two-channel fluorescence (DAPI + Cy3) from a single-molecule FISH study of FLC gene expression in Arabidopsis. Shown in MIP mode.',
  //   source: { label: 'BioImage Archive · S-BIAD425 (IM1)', url: 'https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/pages/S-BIAD425/IM1.html' },
  // },
  {
    title: 'Arabidopsis FLC · IM500',
    meta: 'Fluorescence · 8-bit · 2 channels · 1024 × 512 × 46',
    href: 'app/multichannel/?dataset=https%3A%2F%2Fuk1s3.embassy.ebi.ac.uk%2Fbia-integrator-data%2FS-BIAD425%2FIM500%2FIM500.zarr%2F0&up=-z&mode=mip&scale=0.50&cam=1.090%2C1.350%2C1.027%2C0.005%2C0.010%2C0.030&channels=30%2C255%2C0%2C1.00%2C1%2C0.00%2C0.05%3B30%2C0%2C255%2C1.00%2C1%2C0.45%2C1.00&slice=512%2C256%2C23%2C1%2C1%2C1',
    thumb: 'gallery/arabidopsis-flc-im500.webp',
    alt: 'Arabidopsis FLC smFISH, 2-channel fluorescence',
    description:
      'Two-channel fluorescence from the Arabidopsis FLC gene-expression study (8-bit). Shown in MIP mode.',
    source: { label: 'BioImage Archive · S-BIAD425 (IM500)', url: 'https://uk1s3.embassy.ebi.ac.uk/bia-integrator-data/pages/S-BIAD425/IM500.html' },
  },
  {
    title: 'Yeast smFISH (IDR0047)',
    meta: 'Fluorescence · 16-bit · 4 channels · 2048 × 2048 × 25',
    href: 'app/multichannel/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2Fmultichannel%2F4496763.zarr%2F4496763.zarr&up=-y&mode=slice&scale=0.50&cam=-0.380%2C3.140%2C1.261%2C-0.001%2C0.074%2C0.007&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.04%3B255%2C255%2C0%2C1.00%2C1%2C0.02%2C0.04%3B255%2C0%2C0%2C1.00%2C1%2C0.01%2C0.09%3B255%2C255%2C255%2C1.00%2C1%2C0.01%2C0.05&slice=1024%2C1024%2C13%2C1%2C1%2C1',
    thumb: 'gallery/yeast.webp',
    alt: 'Yeast smFISH, 4-channel fluorescence',
    description:
      'Single-molecule mRNA FISH in Saccharomyces cerevisiae. Channels: CY5, TMR, DAPI, and transmitted light. Shown in slice mode.',
    source: { label: 'IDR0047 · Li & Neuert, 2019', url: 'https://doi.org/10.1038/s41597-019-0106-6' },
  },
  {
    title: 'Drosophila brain (Fly-eFISH)',
    meta: 'Fluorescence · 16-bit · 4 channels · 1920 × 1920 × 752',
    href: 'app/multichannel/?dataset=https%3A%2F%2Fd39zu0xtgv0613.cloudfront.net%2FFly-eFISH%2FNP01_1_1_SS00790_AstA546_CCHa1_647_1x_LOL.chunked.zarr%2F&up=-z&mode=mip&scale=0.50&cam=0.390%2C4.230%2C2.087%2C-0.013%2C-0.016%2C0.060&channels=0%2C0%2C255%2C1.00%2C1%2C0.00%2C0.41%3B255%2C255%2C0%2C1.00%2C1%2C0.00%2C0.19%3B255%2C0%2C0%2C1.00%2C1%2C0.00%2C0.41%3B255%2C255%2C255%2C1.00%2C1%2C0.00%2C0.11&slice=960%2C960%2C376%2C1%2C1%2C1',
    thumb: 'gallery/fly-efish.webp',
    alt: 'Drosophila brain, 4-channel fluorescence FISH',
    description:
      'Drosophila brain multiplexed FISH (Fly-eFISH) — four fluorescence channels including AstA (546 nm) and CCHa1 (647 nm) markers. Large volume, shown in MIP mode. Note: this is a heavy dataset and may take longer to stream in.',
  },
];
