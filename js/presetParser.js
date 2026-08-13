/**
 * Premiere Pro Subtitle & Text Style Preset Parser
 * Parses Premiere Pro (.prfpset / .prtextstyle) XML documents and JSON configurations
 */

class PresetParser {
  constructor() {
    this.defaultPresets = {
      classic_yellow: {
        id: 'classic_yellow',
        name: 'Classic Film Yellow (Premiere Pro)',
        fontFamily: 'Inter',
        fontSize: 44,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffea00',
        enableStroke: true,
        strokeColor: '#000000',
        strokeWidth: 6,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 75,
        bgBoxPadding: 12,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 8,
        shadowOffsetY: 4,
        align: 'bottom-center',
        bottomMargin: 50,
        animationPreset: 'none'
      },
      tiktok_pop: {
        id: 'tiktok_pop',
        name: 'TikTok Pop (Bold Cyan Stroke)',
        fontFamily: 'Montserrat',
        fontSize: 48,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: true,
        fillColor: '#ffffff',
        enableStroke: true,
        strokeColor: '#00d2ff',
        strokeWidth: 8,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 80,
        bgBoxPadding: 10,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 10,
        shadowOffsetY: 6,
        align: 'bottom-center',
        bottomMargin: 60,
        animationPreset: 'pop'
      },
      netflix_clean: {
        id: 'netflix_clean',
        name: 'Netflix Clean (Bottom Center)',
        fontFamily: 'Inter',
        fontSize: 38,
        fontWeightBold: false,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffffff',
        enableStroke: true,
        strokeColor: '#000000',
        strokeWidth: 4,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 60,
        bgBoxPadding: 8,
        enableShadow: true,
        shadowColor: '#000000',
        shadowBlur: 6,
        shadowOffsetY: 3,
        align: 'bottom-center',
        bottomMargin: 45,
        animationPreset: 'none'
      },
      cinematic_boxed: {
        id: 'cinematic_boxed',
        name: 'Cinematic Black Box',
        fontFamily: 'Roboto',
        fontSize: 40,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffffff',
        enableStroke: false,
        strokeColor: '#000000',
        strokeWidth: 0,
        enableBgBox: true,
        bgBoxColor: '#000000',
        bgBoxOpacity: 85,
        bgBoxPadding: 14,
        enableShadow: false,
        shadowColor: '#000000',
        shadowBlur: 0,
        shadowOffsetY: 0,
        align: 'bottom-center',
        bottomMargin: 55,
        animationPreset: 'fade'
      },
      cyber_neon: {
        id: 'cyber_neon',
        name: 'Cyber Neon Glow',
        fontFamily: 'Outfit',
        fontSize: 46,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: true,
        fillColor: '#00ffff',
        enableStroke: true,
        strokeColor: '#ff00ff',
        strokeWidth: 4,
        enableBgBox: false,
        bgBoxColor: '#121212',
        bgBoxOpacity: 90,
        bgBoxPadding: 10,
        enableShadow: true,
        shadowColor: '#00ffff',
        shadowBlur: 16,
        shadowOffsetY: 0,
        align: 'bottom-center',
        bottomMargin: 50,
        animationPreset: 'karaoke'
      },
      minimal_white: {
        id: 'minimal_white',
        name: 'Minimal White Shadow',
        fontFamily: 'Inter',
        fontSize: 36,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: '#ffffff',
        enableStroke: false,
        strokeColor: '#000000',
        strokeWidth: 0,
        enableBgBox: false,
        bgBoxColor: '#000000',
        bgBoxOpacity: 50,
        bgBoxPadding: 6,
        enableShadow: true,
        shadowColor: 'rgba(0,0,0,0.8)',
        shadowBlur: 10,
        shadowOffsetY: 4,
        align: 'bottom-center',
        bottomMargin: 40,
        animationPreset: 'none'
      }
    };
  }

  getPreset(id) {
    return this.defaultPresets[id] || this.defaultPresets['classic_yellow'];
  }

  /**
   * Parse uploaded Premiere Pro preset (.prfpset / .prtextstyle / XML / JSON)
   */
  parsePresetFile(fileContent, fileName) {
    try {
      // Try JSON format
      if (fileContent.trim().startsWith('{')) {
        const parsed = JSON.parse(fileContent);
        return this.normalizePreset(parsed, fileName);
      }

      // Try XML parsing for Premiere Pro .prfpset / .prtextstyle
      const parser = new DOMParser();
      const xmlDoc = parser.parseFromString(fileContent, 'text/xml');
      
      const fontNode = xmlDoc.querySelector('FontFamily, Font, TextFont');
      const sizeNode = xmlDoc.querySelector('FontSize, Size');
      const fillColorNode = xmlDoc.querySelector('FillColor, Color, TextColor');
      const strokeColorNode = xmlDoc.querySelector('StrokeColor, OutlineColor');
      const strokeWidthNode = xmlDoc.querySelector('StrokeWidth, OutlineWidth');
      const shadowNode = xmlDoc.querySelector('DropShadow, Shadow');
      const bgNode = xmlDoc.querySelector('Background, BackgroundBox');
      const alignNode = xmlDoc.querySelector('Alignment, Align');

      const preset = {
        name: fileName.replace(/\.[^/.]+$/, ''),
        fontFamily: fontNode ? fontNode.textContent.trim() : 'Inter',
        fontSize: sizeNode ? parseInt(sizeNode.textContent.trim(), 10) : 42,
        fontWeightBold: true,
        fontStyleItalic: false,
        textUppercase: false,
        fillColor: fillColorNode ? this.parseColorString(fillColorNode.textContent) : '#ffea00',
        enableStroke: !!strokeColorNode,
        strokeColor: strokeColorNode ? this.parseColorString(strokeColorNode.textContent) : '#000000',
        strokeWidth: strokeWidthNode ? parseInt(strokeWidthNode.textContent, 10) : 6,
        enableBgBox: !!bgNode,
        bgBoxColor: bgNode ? this.parseColorString(bgNode.textContent) : '#000000',
        bgBoxOpacity: 75,
        bgBoxPadding: 12,
        enableShadow: !!shadowNode,
        shadowColor: '#000000',
        shadowBlur: 8,
        shadowOffsetY: 4,
        align: alignNode ? alignNode.textContent.trim().toLowerCase() : 'bottom-center',
        bottomMargin: 50,
        animationPreset: 'none'
      };

      return this.normalizePreset(preset, fileName);
    } catch (e) {
      console.warn('Failed XML/JSON parse for preset, falling back to default:', e);
      return this.defaultPresets['classic_yellow'];
    }
  }

  parseColorString(colorStr) {
    if (!colorStr) return '#ffffff';
    colorStr = colorStr.trim();
    if (colorStr.startsWith('#')) return colorStr;
    if (colorStr.startsWith('0x')) return '#' + colorStr.slice(2);
    // RGBA comma separated integers
    const parts = colorStr.split(',').map(p => parseInt(p.trim(), 10));
    if (parts.length >= 3) {
      const r = parts[0].toString(16).padStart(2, '0');
      const g = parts[1].toString(16).padStart(2, '0');
      const b = parts[2].toString(16).padStart(2, '0');
      return `#${r}${g}${b}`;
    }
    return '#ffffff';
  }

  normalizePreset(presetObj, nameFallback) {
    return {
      id: 'custom_' + Date.now(),
      name: presetObj.name || nameFallback || 'Imported Premiere Preset',
      fontFamily: presetObj.fontFamily || 'Inter',
      fontSize: presetObj.fontSize || 42,
      fontWeightBold: presetObj.fontWeightBold !== undefined ? presetObj.fontWeightBold : true,
      fontStyleItalic: !!presetObj.fontStyleItalic,
      textUppercase: !!presetObj.textUppercase,
      fillColor: presetObj.fillColor || '#ffea00',
      enableStroke: presetObj.enableStroke !== undefined ? presetObj.enableStroke : true,
      strokeColor: presetObj.strokeColor || '#000000',
      strokeWidth: presetObj.strokeWidth || 6,
      enableBgBox: !!presetObj.enableBgBox,
      bgBoxColor: presetObj.bgBoxColor || '#000000',
      bgBoxOpacity: presetObj.bgBoxOpacity !== undefined ? presetObj.bgBoxOpacity : 75,
      bgBoxPadding: presetObj.bgBoxPadding || 12,
      enableShadow: presetObj.enableShadow !== undefined ? presetObj.enableShadow : true,
      shadowColor: presetObj.shadowColor || '#000000',
      shadowBlur: presetObj.shadowBlur || 8,
      shadowOffsetY: presetObj.shadowOffsetY || 4,
      align: presetObj.align || 'bottom-center',
      bottomMargin: presetObj.bottomMargin || 50,
      animationPreset: presetObj.animationPreset || 'none'
    };
  }

  exportPresetToXml(preset) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<PremiereData Version="1.0">
  <TextPreset Name="${preset.name}">
    <FontFamily>${preset.fontFamily}</FontFamily>
    <FontSize>${preset.fontSize}</FontSize>
    <FillColor>${preset.fillColor}</FillColor>
    <StrokeEnabled>${preset.enableStroke}</StrokeEnabled>
    <StrokeColor>${preset.strokeColor}</StrokeColor>
    <StrokeWidth>${preset.strokeWidth}</StrokeWidth>
    <BackgroundBoxEnabled>${preset.enableBgBox}</BackgroundBoxEnabled>
    <BackgroundBoxColor>${preset.bgBoxColor}</BackgroundBoxColor>
    <BackgroundBoxOpacity>${preset.bgBoxOpacity}</BackgroundBoxOpacity>
    <BackgroundBoxPadding>${preset.bgBoxPadding}</BackgroundBoxPadding>
    <ShadowEnabled>${preset.enableShadow}</ShadowEnabled>
    <ShadowColor>${preset.shadowColor}</ShadowColor>
    <ShadowBlur>${preset.shadowBlur}</ShadowBlur>
    <ShadowOffsetY>${preset.shadowOffsetY}</ShadowOffsetY>
    <Alignment>${preset.align}</Alignment>
    <BottomMargin>${preset.bottomMargin}</BottomMargin>
  </TextPreset>
</PremiereData>`;
  }
}

window.PresetParser = PresetParser;
