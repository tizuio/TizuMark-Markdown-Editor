# TizuMark

**TizuMark** es un **editor de Markdown** ligero y de código abierto para Windows con vista previa en tiempo real WYSIWYG, navegación por esquema, soporte integrado de KaTeX y Mermaid: una alternativa gratuita a **Typora** construida con Tauri + Rust.

🌐 [简体中文](README.md) | [English](README.en.md) | **Español**

<div align="center">

![TizuMark](icon.png)

</div>

<p align="center">
  <b>⚡Ligero &nbsp;·&nbsp; 🚀Ultra rápido &nbsp;·&nbsp; ✨Minimalista &nbsp;·&nbsp; 🆓<font color="#16a34a">Gratuito y de código abierto</font></b>
  <br>
  <b>Un editor de Markdown limpio, rápido y eficiente</b>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Version-1.2.3-blue" alt="Versión">
  <img src="https://img.shields.io/badge/Windows-7%2B-brightgreen" alt="Windows">
  <img src="https://img.shields.io/badge/macOS-Planificado-lightgrey" alt="macOS">
  <img src="https://img.shields.io/badge/Linux-Planificado-lightgrey" alt="Linux">
  <img src="https://img.shields.io/badge/Tauri-2.x-orange" alt="Tauri">
  <img src="https://img.shields.io/badge/Rust-1.77%2B-black" alt="Rust">
  <img src="https://img.shields.io/badge/Licencia-GPL--3.0-blue" alt="Licencia">
</p>

<p align="center" style="font-size:1.15em"><b>Instalador de ~7MB · &lt;50MB RAM · Doble clic para iniciar</b></p>

<p align="center">
  <img src="demo.gif" alt="Demostración de funciones de TizuMark" width="880">
</p>

---

## ¿Por qué TizuMark?

<p align="center"><b>Abrir. Leer. Editar. Exportar. Sin complicaciones.</b></p>

No faltan editores de Markdown en el mundo. Sin embargo, la mayoría cae en uno de dos extremos: gigantes pesados que consumen cientos de megabytes de memoria, o juguetes demasiado básicos para el trabajo real. TizuMark se sitúa exactamente en el punto ideal.

| Desafío habitual | Modo tradicional | ✨ TizuMark |
|---|---|---|
| 🐢 **Demasiado pesado** | Cientos de MB en RAM, gigabytes de instalación, inicio lento | **Motor en Rust. Instalador de ~7MB, <50MB RAM, arranca en un segundo** |
| 👯 **Vistas divididas incómodas** | Código a un lado, renderizado al otro: deslizar y forzar la vista | **Vista previa en tiempo real WYSIWYG, desplazamiento sincronizado automáticamente** |
| 🌀 **Documentos largos** | Desplazamiento infinito, difícil encontrar una sección | **Esquema de títulos generado automáticamente, un clic para saltar a cualquier capítulo** |
| 🧩 **Matemáticas y diagramas** | Instalar LaTeX, cambiar de herramienta, exportar y pegar | **KaTeX y Mermaid integrados: fórmulas y gráficos se generan desde el propio código** |

---

## Características principales

- ⚡ **Extremadamente rápido y liviano**: Construido sobre **Rust + Tauri v2** (WebView nativo), instalador de ~**7MB**, consumo de **<50MB** de RAM, inicio en menos de un segundo (hasta un 80% menos memoria que aplicaciones basadas en Electron).
- 👁️ **Vista previa en tiempo real**: Escribe a la izquierda y observa el resultado a la derecha. Desplazamiento bidireccional sincronizado sin tener que alternar ventanas.
- 🧠 **Vista inteligente según el tipo de archivo**: Markdown divide automáticamente edición y vista previa; texto plano y código abren en editor puro; imágenes abren en vista de solo lectura.
- 🧭 **Esquema de navegación inteligente**: Analiza la jerarquía de títulos (H1–H6), permitiendo navegar con un solo clic.
- 📐 **Matemáticas KaTeX integradas**: Fórmulas en línea y en bloque, matrices, sistemas de ecuaciones: artículos, apuntes y fórmulas científicas resueltas con facilidad.
- 📊 **Diagramas Mermaid nativos**: Diagramas de flujo, diagramas de secuencia, gráficos de estado y Gantt generados a partir de bloques de texto.
- 🗂️ **Gestión de carpetas y proyectos**: Abre cualquier directorio con `Archivo → Abrir carpeta`; navega por el árbol de archivos con monitoreo automático de cambios en disco.
- 🖼️ **Gestión avanzada de imágenes**: Pega imágenes directamente desde el portapapeles con deduplicación por hash MD5 y selector de almacenamiento (carpeta `assets/` o Base64 incrustado).
- 📑 **Edición multipestaña y restauración de sesión**: Múltiples pestañas con arrastrar para reordenar, advertencia de cambios sin guardar y restauración completa al reiniciar.
- 🎨 **Personalización completa**: Modos claro y oscuro, 5 esquemas de color elegantes (Predeterminado, Atardecer, Bosque, Nord, Crepúsculo), fuentes personalizadas y ajuste fino de márgenes y tamaños.
- ⌨️ **Atajos de teclado personalizables**: Esquemas integrados listos para usar (Predeterminado, VSCode, Typora, Sublime Text) o configuración personalizada tecla por tecla.
- 📤 **Exportación versátil**: Exporta a HTML independiente con estilos completos, imagen PNG en alta definición, PDF vectorial y documentos nativos de Microsoft Word (.docx).
- 🌐 **Internacionalización completa**: Soporte nativo para **Español**, **English** y **简体中文**.

---

## Guía de instalación y desarrollo

### Descargas
Visita la sección de [Releases en GitHub](https://github.com/tizuio/TizuMark-Markdown-Editor/releases) para obtener el instalador oficial o ejecutable portátil para Windows.

### Ejecución en modo desarrollo

1. **Requisitos previos**:
   - [Node.js](https://nodejs.org/) (versión 18+)
   - [Rust](https://www.rust-lang.org/) (versión 1.77+)
   - Dependencias de Tauri para tu sistema operativo

2. **Instalación y ejecución**:
   ```bash
   # Instalar dependencias del proyecto
   npm install

   # Ejecutar en modo desarrollo con recarga en vivo
   npm run dev

   # Ejecutar suite de pruebas
   npm test

   # Comprobaciones de calidad y arquitectura
   npm run check
   ```

---

## Licencia

Este proyecto está bajo la licencia **GPL v3 (GNU General Public License v3.0)**. Consulta el archivo [LICENSE](LICENSE) para más detalles.
