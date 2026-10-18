---
title: 'Kiln: out-of-core volume rendering of OME-Zarr data in the browser with WebGPU'
tags:
  - TypeScript
  - WebGPU
  - volume rendering
  - out-of-core rendering
  - OME-Zarr
  - microscopy
  - scientific visualization
authors:
  - name: Martin Panknin
    orcid: 0009-0004-1257-1705
    affiliation: 1
affiliations:
  - name: Independent researcher, Germany
    index: 1
date: 18 October 2026
bibliography: paper.bib
---

# Summary

Kiln is a volume renderer for the web browser that displays three-dimensional imaging data larger than the memory of the graphics processing unit (GPU). It reads multiscale OME-Zarr [@moore2021ngff; @moore2023omezarr] from object storage, a web server or the local file system, and renders it with direct volume rendering, maximum intensity projection, isosurfaces and slice planes at interactive frame rates. Only the parts of the volume that the current view needs are loaded, at the resolution the screen can show, into a GPU cache of fixed size. Kiln is written in TypeScript on WebGPU [@webgpu] and needs no installation or server. It is distributed as an npm library and as a viewer application whose views can be shared as links.

# Statement of need

Light-sheet and electron microscopy, micro-computed tomography and numerical simulation produce volumes from gigabytes to terabytes. These are increasingly stored as chunked, multiscale OME-Zarr in cloud object storage, so that they can be accessed where they are rather than copied [@moore2023omezarr]. Looking at such data in 3D still usually means downloading it into a desktop application, or settling for slices or a reduced resolution in the browser.

Kiln is for researchers and data providers who want to share a link to a large volume and let anyone explore it in 3D, at full resolution where it matters, on an ordinary laptop. It renders the data as stored: a dataset published as multiscale OME-Zarr can be viewed in Kiln as soon as it is uploaded, without conversion or preprocessing.

# State of the field

Web viewers for OME-Zarr serve different needs. Neuroglancer [@neuroglancer] streams multiscale chunked volumes at terabyte scale and centres on slice views, meshes and annotation, with volume rendering in WebGL2. Viv [@manz2022viv], used by Vitessce [@keller2025vitessce], focuses on multiscale multiplexed 2D images. Vol-E [@vole] offers 3D volume rendering of OME-Zarr with WebGL. webKnossos [@boergens2017webknossos] targets annotation of large electron microscopy volumes. On the desktop, napari [@napari] and the BigDataViewer family [@pietzsch2015bdv], including the out-of-core volume renderer BigVolumeBrowser [@bigvolumebrowser], require a local installation. Luxar [@royer2026luxar] takes a different route: it compiles fluorescence volumes into Gaussian splats in a GPU preprocessing step and renders those in the browser.

Out-of-core GPU volume rendering is well studied [@beyer2015star], from bricked virtual memory with page tables [@hadwiger2012petascale] to ray-guided streaming [@crassin2009gigavoxels]. The Residency Octree [@herzberger2024residency] brought related ideas to the web with WebGL, but is not available as a maintained open-source tool. Kiln's contribution is a maintained, open-source implementation of these techniques in WebGPU compute shaders that renders voxel data directly from OME-Zarr.

# Software design

Kiln is built around a fixed GPU memory budget, so it never needs the whole volume at once. The main design decisions and their trade-offs are documented in the repository and summarised here.

**Bricks and virtual texturing.** Every resolution level is divided into bricks of 64³ voxels. Resident bricks occupy slots of one large 3D texture, the atlas, whose size follows a memory budget (about 1.4 GB by default, divided among channels). A small indirection texture maps each brick position of the finest level to the atlas slot and level that currently represent it, in the manner of an operating system's page table [@hadwiger2012petascale]. A coarse brick fills all the cells it covers, the finest resident level wins, and a reserved value marks bricks known to be empty so that rays skip them. Each brick carries a one-voxel border copied from its neighbours, which makes hardware trilinear filtering seamless across brick faces without special cases in the shader. The cost of this choice is that assembling a brick also touches the neighbouring storage chunks.

**Level selection and residency.** Every few frames, Kiln determines the desired set of bricks: those in the view frustum, each at the coarsest level whose projected voxel size stays below a screen-space error threshold (8 pixels by default), with hysteresis against flicker and the nearest bricks requested first. The coarsest level is loaded first and pinned in the atlas, and missing bricks are drawn from their coarser ancestors, so the image is complete from the first frame and refines progressively. When the atlas is full, the least recently used bricks are evicted.

**Fetching off the main thread.** Chunks are fetched over HTTP and decoded (blosc, zstd, gzip and others) in a pool of web workers with chunk caching, then converted to the atlas format. Unsigned 8- and 16-bit data are stored as normalised textures; signed and floating-point data as 16-bit floats with a value range for windowing. Up to four channels are rendered together.

**Rendering.** A WebGPU compute shader casts one ray per pixel and marches through the volume brick by brick via the indirection texture. The step size follows each brick's level, and Beer–Lambert compositing [@max1995optical] keeps opacity consistent when the step changes; rays stop once nearly opaque [@kruger2003acceleration]. Compute passes keep the pipeline simple: temporal accumulation and resolution scaling need no intermediate framebuffers. Kiln renders at reduced resolution while the camera moves; at rest it accumulates up to 64 frames with jittered ray start offsets and then stops rendering, so an idle viewer uses no GPU time.

**Ray-guided selection (experimental).** Behind a URL flag, the shader marks each brick that a ray actually enters, the browser reads this back asynchronously, and bricks hidden behind opaque material are no longer requested [@crassin2009gigavoxels]. In first measurements on a micro-CT dataset, in a view that refines to full resolution, this reduced the downloaded data about fourfold.

**Interfaces and quality.** The npm library exposes a viewer class for embedding in other web applications, and the complete view state can be serialised into a URL for reproducible, shareable views. More than 480 unit tests run in continuous integration, and every pull request deploys a preview of the viewer for visual review.

# Research impact statement

Kiln is listed in the OME-NGFF tools registry and archived on Zenodo [@kiln]. It opens public datasets directly from their URLs, including the OME-Zarr edition of the Open SciVis datasets [@klacansky2017scivis; @omezarrscivis] (computed tomography and simulation data) and public webKnossos electron microscopy datasets. While testing Kiln against the Open SciVis collection, the author found defects in several of its OME-Zarr stores, confirmed them in two independent viewers, and reported them to the maintainers. Because views are plain links and the renderer is an npm library, data portals and existing web tools can link to Kiln or embed it to add out-of-core 3D rendering.

# AI usage disclosure

Generative AI tools were used extensively in developing Kiln. A large part of the code, tests and documentation was written with Anthropic's Claude through Claude Code, with occasional use of GitHub Copilot, and Claude helped draft this paper. The author framed the problems and made the architectural and design decisions described above, building on his earlier work in volume rendering, and directed all work through pull requests. Every change was reviewed by the author before merging, checked by continuous integration (type checking and unit tests) and inspected on a preview deployment of the viewer; rendering and streaming changes were also measured with a built-in benchmark on real datasets. Conventions for AI agents working on the code are documented in the repository. The author takes full responsibility for the software and this paper.

# Acknowledgements

The author thanks the OME-NGFF community and the maintainers of the Open SciVis datasets and their OME-Zarr edition for openly available test data.

# References
