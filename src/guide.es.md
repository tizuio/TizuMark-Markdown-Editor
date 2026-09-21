# Guía de uso de TizuMark

> Un editor de Markdown rápido y elegante: desde los conceptos básicos hasta el dominio total

[TOC]

---

## Primeros pasos

### Descripción de la interfaz

La interfaz de TizuMark consta de cuatro áreas principales:

| Área | Posición | Propósito |
|------|----------|-----------|
| **Barra de herramientas superior** | Superior | Operaciones con archivos, inserción rápida, modos de vista, temas, ayuda |
| **Barra lateral** | Izquierda | Navegación por esquema y árbol de archivos (al abrir una carpeta) |
| **Editor** | Centro | CodeMirror con resaltado de sintaxis Markdown y autocierre de corchetes / comillas |
| **Vista previa** | Derecha | Markdown renderizado en tiempo real con sincronización de desplazamiento |

### Operaciones básicas

| Acción | Método | Atajo |
|--------|--------|-------|
| Nuevo archivo | `Archivo → Nuevo` | <kbd>Ctrl</kbd> + <kbd>N</kbd> |
| Abrir archivo | `Archivo → Abrir` (admite selección múltiple) | <kbd>Ctrl</kbd> + <kbd>O</kbd> |
| Abrir carpeta | `Archivo → Abrir carpeta` | — |
| Guardar archivo | `Archivo → Guardar` | <kbd>Ctrl</kbd> + <kbd>S</kbd> |
| Guardar como | `Archivo → Guardar como` | — |
| Archivos recientes | `Archivo → Archivos recientes` | — |
| Abrir desde terminal | `tizumark.exe documento.md` | — |
| Cerrar pestaña | Clic en × de la pestaña o clic derecho | <kbd>Ctrl</kbd> + <kbd>W</kbd> |

> **Arrastra y suelta** archivos `.md` directamente dentro de la ventana (admite múltiples archivos). `Archivo → Archivos recientes` permite reabrir rápidamente documentos editados con anterioridad.

---

## Características del editor

### Modos de vista

Las dos pestañas en el centro de la barra de herramientas alternan entre dos modos de visualización:

- **Modo vista previa**: Visualización a pantalla completa del documento renderizado, ideal para lectura y presentaciones.
- **Modo edición**: Escritura a la izquierda y vista previa renderizada a la derecha.

En modo edición:

| Acción | Método |
|--------|--------|
| Contraer editor | Clic en el botón izquierdo <kbd>◄</kbd> |
| Contraer vista previa | Clic en el botón derecho <kbd>►</kbd> |
| Redimensionar paneles | Arrastra el divisor central |

### Barra lateral: Esquema y Archivos

Haz clic en `Ver → Barra lateral` para mostrar u ocultar la barra lateral. Cuenta con dos pestañas:

- **Esquema**: Muestra automáticamente la estructura de títulos del documento (H1–H6), indentada por niveles. **Haz clic en cualquier título**: la vista previa se desplaza y centra en él inmediatamente. El esquema se actualiza en tiempo real mientras escribes.
- **Archivos**: Tras abrir un directorio con `Archivo → Abrir carpeta`, esta pestaña presenta un árbol de archivos. Haz clic en cualquier archivo para abrirlo en una pestaña. El árbol monitorea la carpeta en busca de adiciones o eliminaciones externas y se actualiza de forma automática.

### Edición multipestaña

| Acción | Método |
|--------|--------|
| Nueva pestaña | Clic en <kbd>+</kbd> en la barra de pestañas o <kbd>Ctrl</kbd> + <kbd>N</kbd> |
| Cambiar pestaña | <kbd>Ctrl</kbd> + <kbd>Tab</kbd> / <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> |
| Reordenar por arrastre | Arrastra una pestaña para cambiar su posición |
| Cerrar pestaña | Clic en × o <kbd>Ctrl</kbd> + <kbd>W</kbd> |
| Menú contextual | Cerrar / Cerrar las demás / Cerrar todas / Copiar ruta |
| Doble clic | En el espacio vacío de la barra de pestañas para crear una nueva |

Las pestañas con cambios sin guardar muestran un indicador `*`.

**Restauración de sesión**: Al reabrir TizuMark, se restauran automáticamente las pestañas anteriores, el espacio de trabajo de la carpeta y los directorios expandidos, continuando exactamente donde lo dejaste.

### Buscar y reemplazar

Dos sistemas de búsqueda independientes:

**Buscar y reemplazar en el editor** (<kbd>Ctrl</kbd> + <kbd>F</kbd>):

| Característica | Descripción |
|----------------|-------------|
| Búsqueda básica | Introduce la palabra clave, navega entre coincidencias y consulta el recuento |
| Reemplazar | Introduce el texto de reemplazo, haz clic en Reemplazar o Reemplazar todo |
| Coincidir mayúsculas/minúsculas | Diferencia exacta entre mayúsculas y minúsculas |
| Expresión regular | Admite expresiones regulares compatibles con JavaScript |
| Búsqueda circular | Continúa desde el inicio tras alcanzar el final del documento |

**Buscar en vista previa** (<kbd>Ctrl</kbd> + <kbd>F</kbd> en modo vista previa): Búsqueda directa dentro del contenido renderizado con resaltado en amarillo.

**Búsqueda en múltiples archivos** (<kbd>Ctrl</kbd> + <kbd>H</kbd>): Busca en todas las pestañas abiertas o en un directorio especificado, con opciones de regex y mayúsculas/minúsculas. Los resultados se agrupan por archivo con número de línea/columna y fragmento contextual; haz clic en cualquier resultado para saltar directamente a él en el editor y en la vista previa.

### Menús contextuales

Tres menús contextuales de clic derecho para optimizar el flujo de trabajo:

- **Editor**: Cortar / Copiar / Pegar / Inserción de estructura / Formato de texto / Listas / Enlaces y multimedia / Buscar y reemplazar / Seleccionar todo
- **Vista previa**: Copiar / Seleccionar todo / Copiar como HTML / Buscar en vista previa
- **Pestaña**: Cerrar / Cerrar las demás / Cerrar todas / Copiar ruta del archivo

### Aviso de modificación externa

Cuando un archivo abierto es modificado por otro programa externo a TizuMark, aparece una barra superior con las opciones **Recargar** / **Ignorar** / **Recargar todo** / **Ignorar todo**, garantizando que nunca sobrescribas cambios por error.

### Protección para documentos extensos

Cuando un documento supera ~5000 líneas o ~4 millones de caracteres, la vista previa cambia automáticamente al modo de ventana deslizante, renderizando únicamente el área cercana a tu posición de lectura (~1200 líneas) en lugar de todo el documento. Esto permite abrir con total fluidez archivos de decenas de miles de líneas.

---

## Atajos de teclado

> La siguiente tabla detalla las **combinaciones de teclas predeterminadas**. Cada una se puede personalizar en **`Archivo → Atajos de teclado`** (modificar, borrar o restablecer). Puedes alternar instantáneamente entre los esquemas **Predeterminado / VSCode / Typora / Sublime Text** sin necesidad de reiniciar la aplicación.

### Archivo y Vista

| Atajo | Acción | Atajo | Acción |
|-------|--------|-------|--------|
| <kbd>Ctrl</kbd> + <kbd>N</kbd> | Nuevo archivo | <kbd>Ctrl</kbd> + <kbd>W</kbd> | Cerrar pestaña |
| <kbd>Ctrl</kbd> + <kbd>O</kbd> | Abrir archivo | <kbd>Ctrl</kbd> + <kbd>\\</kbd> | Alternar vista (Edición / Vista previa) |
| <kbd>Ctrl</kbd> + <kbd>S</kbd> | Guardar archivo | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>T</kbd> | Cambiar tema (Claro / Oscuro) |
| <kbd>Ctrl</kbd> + <kbd>P</kbd> | Búsqueda rápida de archivos | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> | Exportar PDF |

### Búsqueda y Pestañas

| Atajo | Acción | Atajo | Acción |
|-------|--------|-------|--------|
| <kbd>Ctrl</kbd> + <kbd>F</kbd> | Buscar y reemplazar | <kbd>Ctrl</kbd> + <kbd>H</kbd> | Búsqueda en múltiples archivos |
| <kbd>Ctrl</kbd> + <kbd>Tab</kbd> | Siguiente pestaña | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> | Pestaña anterior |

### Edición y Formato (aplica a la selección)

| Atajo | Acción | Atajo | Acción |
|-------|--------|-------|--------|
| <kbd>Ctrl</kbd> + <kbd>B</kbd> | Negrita | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>\`</kbd> | Código en línea |
| <kbd>Ctrl</kbd> + <kbd>I</kbd> | Cursiva | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>K</kbd> | Bloque de código |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> | Insertar enlace | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Q</kbd> | Cita |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>5</kbd> | Tachado | <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd> | Insertar imagen |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>M</kbd> | Bloque matemático | <kbd>Alt</kbd> + <kbd>↑</kbd> | Mover línea/selección arriba |
| <kbd>Ctrl</kbd> + <kbd>Enter</kbd> | Insertar línea abajo | <kbd>Alt</kbd> + <kbd>↓</kbd> | Mover línea/selección abajo |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Enter</kbd> | Insertar línea arriba | | |

### Encabezados

| Atajo | Acción |
|-------|--------|
| <kbd>Ctrl</kbd> + <kbd>1</kbd> ~ <kbd>Ctrl</kbd> + <kbd>6</kbd> | Insertar encabezado H1 ~ H6 |

### Deshacer y Rehacer

| Atajo | Acción |
|-------|--------|
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> | Deshacer |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> (o <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd>) | Rehacer |

### Navegación y Selección en el Documento

| Atajo | Acción | Atajo | Acción |
|-------|--------|-------|--------|
| <kbd>Ctrl</kbd> + <kbd>Home</kbd> | Ir al inicio del documento | <kbd>Shift</kbd> + <kbd>Ctrl</kbd> + <kbd>Home</kbd> | Seleccionar hasta el inicio |
| <kbd>Ctrl</kbd> + <kbd>End</kbd> | Ir al final del documento | <kbd>Shift</kbd> + <kbd>Ctrl</kbd> + <kbd>End</kbd> | Seleccionar hasta el final |
| <kbd>Ctrl</kbd> + <kbd>←</kbd> | Palabra a la izquierda | <kbd>Shift</kbd> + <kbd>Ctrl</kbd> + <kbd>←</kbd> | Seleccionar palabra hacia la izquierda |
| <kbd>Ctrl</kbd> + <kbd>→</kbd> | Palabra a la derecha | <kbd>Shift</kbd> + <kbd>Ctrl</kbd> + <kbd>→</kbd> | Seleccionar palabra hacia la derecha |

### Zoom de fuente con rueda de ratón

| Atajo | Acción |
|-------|--------|
| <kbd>Ctrl</kbd> + Rueda de ratón (en editor o vista previa) | Cambia temporalmente el tamaño de fuente; se guarda tras ~3 s de inactividad |

---

## Barra de herramientas de formato

La barra situada bajo la barra superior proporciona botones de formato rápido (se puede contraer con la flecha derecha):

**Botones directos**: Negrita, Cursiva, Tachado, Enlace, Imagen, Línea horizontal, Resaltado, Superíndice, Subíndice.

**Grupos desplegables**:

- **Estructura**: Código en línea, Bloque de código, Tabla, Cita, Fórmula matemática, Diagrama Mermaid, TOC
- **Listas**: Con viñetas, Numerada, Lista de tareas
- **Encabezados**: H1 – H6
- **Bloques de notas**: Nota / Consejo / Advertencia / Atención / Importante

---

## Inserción y sintaxis en detalle

### Estructura

| Elemento | Sintaxis insertada |
|----------|-------------------|
| Encabezados H1–H6 | Prefijos `#` hasta `######` |
| Bloque de código | Bloque delimitado con ` ``` ` (resaltado para JS, Python, Rust, HTML, CSS, C++, etc.) |
| Tabla | Plantilla inicial de 3×3 |
| Cita | Párrafo con prefijo `>` |
| Bloque de notas | Cuadros estilizados de tipo Nota / Consejo / Advertencia / Atención / Importante |
| Fórmula matemática | Bloque delimitado con `$$` (renderizado con KaTeX) |
| Diagrama Mermaid | Plantilla de diagrama de flujo o secuencia |
| Línea horizontal | Separador `---` |
| TOC | Marcador `[TOC]` (genera tabla de contenidos automáticamente) |

> Fórmulas en línea con `$...$`, en bloque con `$$...$$`.

### Formato de texto

| Formato | Sintaxis | Resultado |
|---------|----------|-----------|
| Negrita | `**texto**` | **texto en negrita** |
| Cursiva | `*texto*` | *texto en cursiva* |
| Tachado | `~~texto~~` | ~~texto tachado~~ |
| Código en línea | `` `código` `` | `fragmento de código` |
| Resaltado | `==texto==` | ==texto resaltado== |
| Superíndice | `<sup>2</sup>` | x² |
| Subíndice | `<sub>2</sub>` | x₂ |

### Listas

- Sin ordenar: prefijo `- `
- Numerada: prefijo `1. `
- Lista de tareas: prefijo `- [ ] ` (se puede marcar/desmarcar en la vista previa)

### Bloques de notas (Callouts)

Bloques estilizados al estilo de GitHub:

```markdown
> [!NOTE]
> Esta es una nota informativa general.

> [!TIP]
> Este es un consejo o recomendación útil.

> [!WARNING]
> Esta es una advertencia que requiere atención.

> [!CAUTION]
> Esta es una llamada de atención sobre posibles riesgos.

> [!IMPORTANT]
> Esta es información crítica o fundamental.
```

---

## Referencia de sintaxis completa

[Abrir el archivo Demo para ver todos los ejemplos de sintaxis →](demo.md)

---

## Gestión de imágenes

TizuMark ofrece soporte integral de imágenes con múltiples métodos de inserción y deduplicación automática.

### Métodos de inserción

| Método | Acción | Descripción |
|--------|--------|-------------|
| Pegar | <kbd>Ctrl</kbd> + <kbd>V</kbd> | Pega una imagen del portapapeles directamente en el editor; se guarda según la configuración de almacenamiento |
| Diálogo de inserción | Botón de imagen o <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>I</kbd> | Selecciona un archivo local o introduce una URL web |
| Menú contextual | Clic derecho en el editor → Insertar imagen | Mismo diálogo de inserción |

> **Arrastrar** una imagen dentro de la ventana la abre como pestaña de vista previa de solo lectura; no la inserta en el documento activo.

### Deduplicación automática

Las imágenes con idéntico contenido se almacenan una sola vez mediante cálculo de **hash MD5**:
- Al pegar o insertar, se calcula el hash MD5 del archivo.
- Si la imagen ya existe, se reutiliza el archivo existente.
- Mismo nombre con contenido distinto no genera conflicto.

### Modos de almacenamiento

En `Archivo → Configuración → Almacenamiento de imágenes`:

- **Copiar a assets/ (recomendado)**: Las imágenes se guardan como archivos independientes; el archivo Markdown permanece ligero y óptimo para Git.
- **Incrustar como Base64**: Las imágenes se codifican dentro del archivo Markdown; documento autocontenido, pero el tamaño aumenta (~1.4x el original).

### Visualizador de imágenes

Haz clic en cualquier imagen de la vista previa para abrir el visor interactivo: **arrastra** para desplazar, **gira la rueda del ratón** para hacer zoom centrado en el puntero y **haz doble clic** para restablecer al tamaño óptimo.

---

## Exportación

### Exportar HTML

`Archivo → Exportar HTML` genera un archivo HTML completamente independiente:
- Estilos CSS completos incluidos.
- Tablas, bloques de código, fórmulas matemáticas y diagramas Mermaid intactos.
- Listo para abrir en cualquier navegador.

### Exportar Imagen

`Archivo → Exportar imagen` genera un PNG en alta resolución:
- Ancho de 800px y altura automática según contenido.
- Respeta el estilo del tema oscuro o claro.

### Exportar PDF

`Archivo → Exportar PDF` (<kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd>):
- Utiliza la ventana de impresión del sistema.
- Permite seleccionar "Guardar como PDF", ajustar márgenes y orientación.
- Fórmulas y diagramas Mermaid se renderizan nítidamente.

### Exportar DOCX

`Archivo → Exportar DOCX` genera un documento `.docx` estándar de Microsoft Word (formato nativo Word 2007+, compatible con Word, LibreOffice y WPS):
- Convierte el contenido con tipografía, jerarquía de títulos, listas, tablas y citas coincidentes con la vista previa.
- Las imágenes y diagramas Mermaid se incrustan como recursos integrados en alta definición.
- Las fórmulas KaTeX se integran limpiamente.

---

## Personalización

En `Archivo → Configuración`:

### Básico

| Ajuste | Opciones | Predeterminado | Descripción |
|--------|----------|----------------|-------------|
| Idioma | 中文 / English / Español | 中文 | Idioma completo de la interfaz |
| Modo de tema | Claro / Oscuro / Seguir al sistema | Claro | Fondo claro, oscuro o sincronizado con el SO |
| Esquema de color | Predeterminado / Atardecer / Bosque / Nord / Crepúsculo | Predeterminado | Estilo cromático de la interfaz |

### Editor y Vista previa

- **Tamaño de fuente del editor**: 8–36px (predeterminado 14px).
- **Tamaño de tabulación**: 2 / 4 / 8 espacios (recomendado 4).
- **Ajuste de línea**: Activar o desactivar ajuste automático.
- **Números de línea**: En el editor y opcionalmente en bloques de código.
- **Interlineado**: 1.4 a 2.0 (predeterminado 1.7).
- **Ancho máximo**: Ilimitado o limitado a 800px, 1000px, 1200px.

---

## Preguntas frecuentes

### ¿Cómo restaurar la configuración predeterminada?
Haz clic en «Restablecer valores predeterminados» en `Archivo → Configuración` o en `Archivo → Atajos de teclado`.

### ¿Formatos de archivo admitidos?
- **Markdown**: `.md`, `.markdown`, `.mdown`, `.mkd`, `.mkdn`, `.mdwn`, `.markdn`
- **Imágenes**: `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.bmp`, `.svg`, `.ico`, `.avif`, `.heic` y más (20 formatos)
- **Texto y código**: `.txt`, `.log`, `.json`, `.yaml`, `.toml`, `.html`, `.css`, `.js`, `.ts`, `.py`, `.rs`, `.go`, `.c`, `.cpp`, `.sh`, `.sql` y 145 en total

### ¿Fórmulas matemáticas que no se renderizan?
Verifica la sintaxis: en línea `$...$`, en bloque `$$...$$`.

---

<p align="center">
  <b>TizuMark — Escribe a la velocidad del pensamiento</b>
</p>
