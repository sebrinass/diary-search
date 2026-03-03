/**
 * 中文分词器 - Bigram + Unigram 实现
 * 
 * 分词策略：
 * 1. 中文连续文本：使用 Bigram（双字组合）+ Unigram（单字）
 * 2. 英文/数字：按空格和标点分割为完整单词
 * 3. 混合文本：分别处理后合并
 */

/**
 * 判断字符是否为中文字符
 * @param {string} char - 单个字符
 * @returns {boolean}
 */
function isChinese(char) {
  const code = char.charCodeAt(0);
  // CJK 统一汉字范围：U+4E00 ~ U+9FFF
  // CJK 扩展A：U+3400 ~ U+4DBF
  // CJK 兼容汉字：U+F900 ~ U+FAFF
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0xf900 && code <= 0xfaff)
  );
}

/**
 * 判断字符是否为英文或数字
 * @param {string} char - 单个字符
 * @returns {boolean}
 */
function isAlphanumeric(char) {
  return /^[a-zA-Z0-9]$/.test(char);
}

/**
 * 对中文文本进行 Bigram + Unigram 分词
 * @param {string} text - 中文文本
 * @returns {string[]} 分词结果
 */
function tokenizeChinese(text) {
  const tokens = [];
  const chars = [...text]; // 支持代理对（emoji等）
  
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    
    if (isChinese(char)) {
      // Unigram: 添加单字
      tokens.push(char);
      
      // Bigram: 添加双字组合
      if (i + 1 < chars.length && isChinese(chars[i + 1])) {
        tokens.push(char + chars[i + 1]);
      }
    }
  }
  
  return tokens;
}

/**
 * 对英文/数字文本进行分词
 * @param {string} text - 英文文本
 * @returns {string[]} 分词结果
 */
function tokenizeEnglish(text) {
  // 按非字母数字字符分割，过滤空字符串，转小写
  return text
    .split(/[^a-zA-Z0-9]+/)
    .filter(token => token.length > 0)
    .map(token => token.toLowerCase());
}

/**
 * 混合分词器：处理中英文混合文本
 * @param {string} text - 输入文本
 * @returns {string[]} 分词结果
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') {
    return [];
  }
  
  const tokens = [];
  let buffer = '';
  let bufferType = 'none'; // 'chinese' | 'english' | 'none'
  
  // 遍历每个字符，按类型分组处理
  for (const char of text) {
    const isChineseChar = isChinese(char);
    const isEnglishChar = isAlphanumeric(char);
    
    // 确定当前字符类型
    const currentType = isChineseChar ? 'chinese' : (isEnglishChar ? 'english' : 'separator');
    
    // 类型切换时处理缓冲区
    if (currentType !== bufferType && bufferType !== 'none' && buffer.length > 0) {
      if (bufferType === 'chinese') {
        tokens.push(...tokenizeChinese(buffer));
      } else if (bufferType === 'english') {
        tokens.push(...tokenizeEnglish(buffer));
      }
      buffer = '';
    }
    
    // 非分隔符字符加入缓冲区
    if (currentType !== 'separator') {
      buffer += char;
      bufferType = currentType;
    } else {
      bufferType = 'none';
    }
  }
  
  // 处理剩余缓冲区
  if (buffer.length > 0) {
    if (bufferType === 'chinese') {
      tokens.push(...tokenizeChinese(buffer));
    } else if (bufferType === 'english') {
      tokens.push(...tokenizeEnglish(buffer));
    }
  }
  
  return tokens;
}

/**
 * 用于 MiniSearch 的分词函数
 * @param {string} text - 输入文本
 * @param {string} _fieldName - 字段名（未使用）
 * @returns {string[]} 分词结果
 */
export function miniSearchTokenizer(text, _fieldName) {
  return tokenize(text);
}

export default {
  tokenize,
  miniSearchTokenizer,
  isChinese,
  isAlphanumeric
};
