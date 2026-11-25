# 🔊 Acoustic-to-3D: Neural Foley & Spatial Acoustics Engine

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WebAudio](https://img.shields.io/badge/Audio-48kHz_Real--Time_DSP-blue.svg)]()
[![Three.js](https://img.shields.io/badge/3D-WebGL_%2F_Three.js-black.svg)]()
[![Status](https://img.shields.io/badge/Status-Active_Prototype-success.svg)]()

**Acoustic-to-3D** is an open-source, real-time procedural foley and spatial acoustics engine that synthesizes physically accurate sound directly from 3D geometry, collision physics, and PBR material properties—**without relying on pre-recorded `.wav` samples**.

Designed as an accessible, physics-driven alternative to proprietary audio middleware (such as Wwise or FMOD), it bridges real-time 3D rendering, modal synthesis, stochastic fracture models, and acoustic ray-tracing.

---

## ✨ Key Features

### 1. Physics-Driven Modal & Excitation Synthesis (48kHz)
* **Dual Hertzian Contact Mechanics:** Collisions simultaneously excite the resonant modes of both impacting bodies (e.g., metal dropping on concrete), distributing energy based on relative hardness, mass, and velocity.
* **Elastic Cavity Resonance:** Models pressurized air cavities (such as bouncing basketballs) with dynamic pitch-envelope modulation tied to impact deformation.
* **Stochastic / Poisson Granular Fracture:** Real-time `AudioWorklet`-ready impulse bursts simulating brittle fracture and micro-collisions (snapping twigs, gravel footsteps, rustling leaves).
* **Non-Linear Shockwaves (Friedlander Wave):** Synthesizes supersonic pressure pulses and explosions with distance-dependent atmospheric low-pass absorption and soft clipping.

### 2. PBR Material-to-Acoustics Mapping
* Translates physical parameters (**Mass**, **Hardness/Stiffness**, **Elasticity**, and **PBR Surface Roughness**) into resonant filter banks ($f_0$, gain, and $Q$-factors) and continuous tangential friction noise.
* **AI Material Profiler:** Generates custom PBR textures and 12-band modal acoustic signatures from natural-language material descriptions.
* **3D Mesh Importer (`.OBJ` / `.GLTF`):** Loads custom 3D models, calculates bounding volume to scale fundamental resonant frequencies, and reads PBR roughness maps at contact points.

### 3. Real-Time Spatial Acoustics & Room EQ Solver
* **3D Acoustic Ray-Tracing:** Computes early reflections, dynamic obstruction/diffraction behind acoustic gobos, and convolution reverb driven by room dimensions and wall absorption coefficients.
* **Interactive Measurement Mic & Sine Sweep:** Drag the virtual measurement microphone anywhere in the 3D room to hear spatial phase/Haas shifts, trigger a 20Hz–20kHz **Sine Sweep**, and export stereo **24-bit/48kHz Impulse Responses (`.WAV`)** for any DAW or game engine.

### 4. Studio-Grade Telemetry & Interactive Foley Showcases
* Live **FFT Spectrum Analyzer**, **Oscilloscope**, **Impulse Response Viewer**, and **LUFS / Peak Metering**.
* Built-in **Foley Showcase Scenes** (Basketball dribbling on hardwood vs. concrete, multi-surface footsteps, modal percussion).

---

## 🏗️ System Architecture

```text
┌──────────────────────────────────────────────────────────────────────┐
│                        3D Viewport & Physics                         │
│  (Three.js / WebGL • Collision Solver • PBR Maps • .OBJ/.GLTF Mesh)  │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │ Impact Force F(t), Tangential Vel,
                                   │ Roughness, Ray-Cast Occlusion
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                    Hybrid Acoustic DSP Engine (48kHz)                │
│  ┌─────────────────────┐  ┌─────────────────────┐  ┌──────────────┐  │
│  │  Modal Filter Bank  │  │  Poisson Granular / │  │  Friedlander │  │
│  │ (Biquad Resonators) │  │  Friction Generator │  │  Shockwave   │  │
│  └──────────┬──────────┘  └──────────┬──────────┘  └──────┬───────┘  │
│             └────────────────────────┼────────────────────┘          │
│                                      ▼                               │
│                  Spatial Acoustic Ray-Tracer & Convolver             │
│           (Early Reflections • Air Absorption • Dynamic IR)          │
└──────────────────────────────────┬───────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  Studio UI, Telemetry & Export                       │
│   (FFT Analyzer • LUFS Meter • .WAV Foley/IR Export • C++ Header)    │
└──────────────────────────────────────────────────────────────────────┘
