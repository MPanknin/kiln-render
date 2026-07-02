# References & Background

Kiln is an implementation-focused project that builds on well-established ideas in volume rendering, sparse streaming, and real-time graphics. It does not introduce new rendering algorithms, but adapts proven techniques to a modern WebGPU context.

See also: [Architecture](architecture.md) | [Rendering Pipeline](rendering.md) | [Data Guide](data-guide.md) | [Usage Guide](usage-guide.md)

---

## Academic & Technical References

The following works were particularly influential during development:

- **Barrett, S. (2008).** *Sparse Virtual Textures*. Game Developers Conference (GDC) 2008.
  [http://silverspaceship.com/src/svt/](http://silverspaceship.com/src/svt/)

- **CesiumGS. (2019).** *3D Tiles: Specification for Streaming Massive Heterogeneous 3D Geospatial Datasets*. Open Geospatial Consortium (OGC) Community Standard.
  [https://github.com/CesiumGS/3d-tiles](https://github.com/CesiumGS/3d-tiles)

- **Engel, K., Hadwiger, M., Kniss, J., Rezk-Salama, C., & Weiskopf, D. (2006).** *Real-Time Volume Graphics*. A K Peters/CRC Press.
  [https://doi.org/10.1201/b10629](https://doi.org/10.1201/b10629)

- **Karis, B. (2014).** *High Quality Temporal Supersampling*. ACM SIGGRAPH 2014, Advances in Real-Time Rendering in Games.
  [https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf](https://de45xmedrsdbp.cloudfront.net/Resources/files/TemporalAA_small-59732822.pdf)

- **Levoy, M. (1990).** *Efficient ray tracing of volume data*. ACM Transactions on Graphics, 9(3), 245–261.
  [https://doi.org/10.1145/78964.78965](https://doi.org/10.1145/78964.78965)

- **Lux, C., & Fröhlich, B. (2009).** *GPU-Based Ray Casting of Multiple Multi-resolution Volume Datasets*. In: Bebis, G., et al. Advances in Visual Computing. ISVC 2009.
  [https://link.springer.com/chapter/10.1007/978-3-642-10520-3_10](https://link.springer.com/chapter/10.1007/978-3-642-10520-3_10)

- **Maitin-Shepard, J., et al. (2021).** *Neuroglancer: Web-based volumetric data visualization*.
  [https://github.com/google/neuroglancer](https://github.com/google/neuroglancer)

- **Moore, J., et al. (2023).** *OME-Zarr: a cloud-optimized bioimaging file format with international community support*. Histochemistry and Cell Biology, 160(3), 223–251.
  [https://doi.org/10.1007/s00418-023-02209-1](https://doi.org/10.1007/s00418-023-02209-1)

- **Schütz, M. (2016).** *Potree: Rendering Large Point Clouds in Web Browsers* [Master's thesis, Technische Universität Wien].
  [https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/](https://www.cg.tuwien.ac.at/research/publications/2016/SCHUETZ-2016-POT/)

- **W3C GPU for the Web Working Group. (2026).** *WebGPU*. W3C Candidate Recommendation Draft.
  [https://gpuweb.github.io/gpuweb/](https://gpuweb.github.io/gpuweb/)

---

## Dataset Credits

Sample datasets used in Kiln demos are from the [Open SciVis Datasets](https://github.com/sci-visus/open-scivis-datasets) collection:

- **Chameleon** - CT scan of *Chamaeleo calyptratus*. Digital Morphology, 2003.
- **Beechnut** - MicroCT scan of a dried beechnut. Computer-Assisted Paleoanthropology group and Visualization and MultiMedia Lab, University of Zurich.
- **Stag Beetle** - Industrial CT scan. Meister Eduard Gröller, Georg Glaeser, Johannes Kastner, 2005.
