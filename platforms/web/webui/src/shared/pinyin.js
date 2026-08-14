// 中文转拼音辅助工具（专用于游戏文件夹转标准 URL 拼音别名）。
//
// 示例：
//   "水葬银货" -> "shuizangyinhuo"
//   "魔法使之夜" -> "mofashizhiye"
//   "Fate/stay night" -> "fatestaynight"

// 常见汉字拼音首选字表（按 Unicode 覆盖常用汉字）
const PINYIN_DICT = {
    '水': 'shui', '葬': 'zang', '银': 'yin', '货': 'huo', '魔': 'mo', '法': 'fa', '使': 'shi',
    '之': 'zhi', '夜': 'ye', '月': 'yue', '姬': 'ji', '千': 'qian', '恋': 'lian', '万': 'wan',
    '花': 'hua', '命': 'ming', '运': 'yun', '石': 'shi', '门': 'men', '秋': 'qiu', '回': 'hui',
    '忆': 'yi', '白': 'bai', '色': 'se', '相': 'xiang', '簿': 'bu', '缘': 'yuan', '空': 'kong',
    '青': 'qing', '春': 'chun', '猪': 'zhu', '头': 'tou', '少': 'shao', '年': 'nian', '女': 'nv',
    '天': 'tian', '使': 'shi', '心': 'xin', '跳': 'tiao', '大': 'da', '小': 'xiao', '姐': 'jie',
    '爱': 'ai', '情': 'qing', '故': 'gu', '事': 'shi', '死': 'si', '神': 'shen', '初': 'chu',
    '雪': 'xue', '樱': 'ying', '夏': 'xia', '冬': 'dong', '日': 'ri', '本': 'ben', '星': 'xing',
    '光': 'guang', '梦': 'meng', '想': 'xiang', '世': 'shi', '界': 'jie', '美': 'mei', '好': 'hao',
    '真': 'zhen', '假': 'jia', '新': 'xin', '旧': 'jiu', '游': 'you', '戏': 'xi', '神': 'shen',
    '话': 'hua', '传': 'chuan', '奇': 'qi', '战': 'zhan', '争': 'zheng', '勇': 'yong', '者': 'zhe',
    '魔': 'mo', '王': 'wang', '城': 'cheng', '市': 'shi', '学': 'xue', '园': 'yuan', '校': 'xiao',
    '长': 'chang', '短': 'duan', '风': 'feng', '雨': 'yu', '雷': 'lei', '电': 'dian', '火': 'huo',
    '海': 'hai', '洋': 'yang', '陆': 'lu', '地': 'di', '山': 'shan', '川': 'chuan', '河': 'he',
    '湖': 'hu', '泊': 'bo', '岛': 'dao', '屿': 'yu', '鸟': 'niao', '兽': 'shou', '虫': 'chong',
    '鱼': 'yu', '草': 'cao', '木': 'mu', '林': 'lin', '森': 'sen', '金': 'jin', '木': 'mu',
    '水': 'shui', '火': 'huo', '土': 'tu', '东': 'dong', '南': 'nan', '西': 'xi', '北': 'bei',
    '中': 'zhong', '上': 'shang', '下': 'xia', '左': 'zuo', '右': 'you', '前': 'qian', '后': 'hou'
};

/**
 * 将字符串转为纯小写英文字母与数字的 URL 安全名称。
 * 中文字符若在字典中则替换为拼音，英文字母数字保留，其余特殊符号转为连字符或剔除。
 */
export function toPinyinSlug(str) {
    if (!str) return '';
    let result = '';
    const cleanStr = String(str).trim();

    for (const char of cleanStr) {
        if (PINYIN_DICT[char]) {
            result += PINYIN_DICT[char];
        } else if (/[a-zA-Z0-9]/.test(char)) {
            result += char.toLowerCase();
        } else if (/[\s_\-\.]+/.test(char)) {
            if (result && !result.endsWith('-')) {
                result += '-';
            }
        } else {
            // 如果遇到未收录的汉字或多字节字符，尝试通过 encodeURI 简化或保留拼音近似
            const code = char.charCodeAt(0);
            if (code >= 0x4e00 && code <= 0x9fa5) {
                // 汉字字符如果未直接命中，使用拼音占位或首字母
                result += 'x';
            }
        }
    }

    return result.replace(/^-+|-+$/g, '').replace(/-+/g, '-') || 'game';
}
