require('dotenv').config();

const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const xml2js = require('xml2js');
const app = express();

const PORT = process.env.PORT || 3000;
// 미들웨어 설정

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// 환경 변수에서 TTBKey 읽기 (선택사항)
const DEFAULT_TTB_KEY = process.env.ALADIN_TTB_KEY || '';

// XML 파서 설정
const xmlParser = new xml2js.Parser({
  explicitArray: false,
  ignoreAttrs: true,
});

// 알라딘 API 검색 엔드포인트
app.get('/api/search', async (req, res) => {
  try {
    const { query, queryType = 'Keyword', maxResults = 10, start = 1, searchTarget = 'Book', version = '20131101', cover = 'Mid' } = req.query;

    // TTBKey 검증
    if (!DEFAULT_TTB_KEY) {
      return res.status(500).json({
        error: 'TTBKey가 설정되지 않았습니다.',
        message: '서버에 환경 변수 ALADIN_TTB_KEY를 설정해주세요.',
      });
    }

    // 검색어 검증
    if (!query || query.trim().length < 2) {
      return res.status(400).json({
        error: '검색어는 2글자 이상이어야 합니다.',
      });
    }

    console.log(`검색 요청: "${query}" (TTBKey: ${DEFAULT_TTB_KEY.substring(0, 10)}...)`);

    // 먼저 JSON 형식으로 시도
    let jsonData = null;
    let lastError = null;

    // output 형식들을 순서대로 시도
    const outputFormats = ['js', 'json', 'xml'];

    for (const outputFormat of outputFormats) {
      try {
        console.log(`시도 중: output=${outputFormat}`);

        const response = await axios.get('http://www.aladin.co.kr/ttb/api/ItemSearch.aspx', {
          params: {
            ttbkey: DEFAULT_TTB_KEY,
            Query: query,
            QueryType: queryType,
            MaxResults: maxResults,
            start: start,
            SearchTarget: searchTarget,
            output: outputFormat,
            Version: version,
            Cover: cover,
          },
          timeout: 5000,
          responseType: 'text',
          headers: {
            Accept: '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          },
        });

        console.log(`응답 받음 (${outputFormat}):`, response.data.substring(0, 200) + '...');

        // 응답 파싱
        if (outputFormat === 'xml') {
          // XML 파싱
          const result = await xmlParser.parseStringPromise(response.data);
          console.log('XML 파싱 결과:', JSON.stringify(result).substring(0, 200));

          if (result.object && result.object.item) {
            // XML 응답을 JSON 형식으로 변환
            jsonData = {
              totalResults: parseInt(result.object.totalResults) || 0,
              startIndex: parseInt(result.object.startIndex) || 1,
              itemsPerPage: parseInt(result.object.itemsPerPage) || 10,
              item: Array.isArray(result.object.item) ? result.object.item : [result.object.item],
            };
            break;
          } else if (result.error) {
            throw new Error(result.error.message || 'API 오류');
          }
        } else {
          // JSON/JSONP 파싱
          if (typeof response.data === 'string') {
            if (response.data.includes('(') && response.data.includes(')')) {
              // JSONP 형식
              const jsonStr = response.data.replace(/^[^(]*\(/, '').replace(/\);?$/, '');
              jsonData = JSON.parse(jsonStr);
            } else {
              // 일반 JSON
              jsonData = JSON.parse(response.data);
            }
          } else {
            jsonData = response.data;
          }

          if (jsonData && !jsonData.errorCode) {
            break;
          }
        }
      } catch (error) {
        console.error(`${outputFormat} 형식 실패:`, error.message);
        lastError = error;
        continue;
      }
    }

    // 모든 형식이 실패한 경우
    if (!jsonData) {
      throw new Error('모든 응답 형식 파싱 실패: ' + (lastError?.message || '알 수 없는 오류'));
    }

    // 에러 체크
    if (jsonData.errorCode) {
      console.error('알라딘 API 에러:', jsonData.errorMessage);
      return res.status(400).json({
        error: 'API 오류',
        message: jsonData.errorMessage || '알라딘 API 오류가 발생했습니다.',
        errorCode: jsonData.errorCode,
      });
    }

    // 성공 응답
    res.json({
      success: true,
      totalResults: jsonData.totalResults || 0,
      startIndex: jsonData.startIndex || 1,
      itemsPerPage: jsonData.itemsPerPage || 10,
      items: jsonData.item || [],
    });
  } catch (error) {
    console.error('서버 오류:', error.message);
    console.error('상세 에러:', error.stack);

    if (error.code === 'ECONNABORTED') {
      res.status(504).json({
        error: '요청 시간 초과',
        message: '알라딘 서버 응답이 너무 느립니다. 잠시 후 다시 시도해주세요.',
      });
    } else if (error.response) {
      res.status(error.response.status).json({
        error: '알라딘 API 오류',
        message: `상태 코드: ${error.response.status}`,
        details: error.response.data,
      });
    } else {
      res.status(500).json({
        error: '서버 오류',
        message: error.message || '서버에서 오류가 발생했습니다.',
      });
    }
  }
});

// 상품 상세 조회 엔드포인트
app.get('/api/lookup', async (req, res) => {
  try {
    const { itemId, itemIdType = 'ISBN13', cover = 'Mid', optResult = '' } = req.query;

    if (!DEFAULT_TTB_KEY) {
      return res.status(500).json({
        error: 'TTBKey가 설정되지 않았습니다.',
        message: '서버에 환경 변수 ALADIN_TTB_KEY를 설정해주세요.',
      });
    }

    if (!itemId) {
      return res.status(400).json({
        error: 'ItemId가 필요합니다.',
      });
    }

    // 다양한 output 형식 시도
    let jsonData = null;
    const outputFormats = ['js', 'json', 'xml'];

    for (const outputFormat of outputFormats) {
      try {
        const response = await axios.get('http://www.aladin.co.kr/ttb/api/ItemLookUp.aspx', {
          params: {
            ttbkey: DEFAULT_TTB_KEY,
            ItemId: itemId,
            ItemIdType: itemIdType,
            output: outputFormat,
            Version: '20131101',
            Cover: cover,
            OptResult: optResult,
          },
          timeout: 5000,
          responseType: 'text',
        });

        if (outputFormat === 'xml') {
          const result = await xmlParser.parseStringPromise(response.data);
          if (result.object && result.object.item) {
            jsonData = {
              item: Array.isArray(result.object.item) ? result.object.item : [result.object.item],
            };
            break;
          }
        } else {
          // JSON/JSONP 파싱
          if (response.data.includes('(') && response.data.includes(')')) {
            const jsonStr = response.data.replace(/^[^(]*\(/, '').replace(/\);?$/, '');
            jsonData = JSON.parse(jsonStr);
          } else {
            jsonData = JSON.parse(response.data);
          }

          if (jsonData && !jsonData.errorCode) {
            break;
          }
        }
      } catch (error) {
        continue;
      }
    }

    if (!jsonData) {
      throw new Error('상품 정보를 가져올 수 없습니다.');
    }

    if (jsonData.errorCode) {
      return res.status(400).json({
        error: 'API 오류',
        message: jsonData.errorMessage || '알라딘 API 오류가 발생했습니다.',
      });
    }

    res.json({
      success: true,
      item: jsonData.item?.[0] || null,
    });
  } catch (error) {
    console.error('상품 조회 오류:', error.message);
    res.status(500).json({
      error: '서버 오류',
      message: '상품 정보를 조회할 수 없습니다.',
    });
  }
});

// 헬스 체크 엔드포인트
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    ttbkeyConfigured: !!DEFAULT_TTB_KEY,
  });
});

// 프록시 엔드포인트 (멀티플랫폼 검색용)
app.get('/api/proxy', async (req, res) => {
  try {
    const { url } = req.query;

    if (!url) {
      return res.status(400).json({
        error: '대상 URL이 필요합니다.',
      });
    }

    // URL 유효성 검증
    let targetUrl;
    try {
      targetUrl = new URL(url);
    } catch (e) {
      return res.status(400).json({
        error: '유효하지 않은 URL입니다.',
      });
    }

    // 허용된 도메인만 프록시 (보안)
    const allowedDomains = [
      'select.ridibooks.com',
      'search-api.ridibooks.com',
      'cremaclub.yes24.com',
      'aladin.co.kr',
      'www.aladin.co.kr',
      'search.kyobobook.co.kr',
      'elib.seoul.go.kr',
      'ebooks.catholic.ac.kr',
    ];

    if (!allowedDomains.includes(targetUrl.hostname)) {
      return res.status(403).json({
        error: '허용되지 않은 도메인입니다.',
      });
    }

    console.log(`프록시 요청: ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
      },
    });

    // 응답 헤더 설정
    res.setHeader('Content-Type', response.headers['content-type'] || 'text/plain');
    res.send(response.data);
  } catch (error) {
    console.error('프록시 오류:', error.message);

    if (error.code === 'ECONNABORTED') {
      res.status(504).json({
        error: '요청 시간 초과',
        message: '대상 서버 응답이 너무 느립니다.',
      });
    } else if (error.response) {
      res.status(error.response.status).json({
        error: '대상 서버 오류',
        message: `상태 코드: ${error.response.status}`,
        details: error.response.statusText,
      });
    } else {
      res.status(500).json({
        error: '프록시 서버 오류',
        message: error.message || '프록시 처리 중 오류가 발생했습니다.',
      });
    }
  }
});

// 루트 경로 처리
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`
🚀 알라딘 API 프록시 서버가 시작되었습니다!
🌐 서버 주소: http://localhost:${PORT}
📚 API 엔드포인트: http://localhost:${PORT}/api/search
❓ 헬스 체크: http://localhost:${PORT}/api/health

${DEFAULT_TTB_KEY ? '✅ TTBKey가 환경 변수로 설정되었습니다.' : '⚠️  TTBKey를 클라이언트에서 전송하거나 환경 변수 ALADIN_TTB_KEY를 설정하세요.'}
    `);
});

// 우아한 종료 처리
process.on('SIGTERM', () => {
  console.log('서버를 종료합니다...');
  process.exit(0);
});
