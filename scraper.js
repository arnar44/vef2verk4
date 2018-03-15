require('dotenv').config();
require('isomorphic-fetch');

const cheerio = require('cheerio');
const redis = require('redis');
const util = require('util');

const {
  REDIS_URL: redisurl = 'redis://127.0.0.1:6379/0',
} = process.env;

const client = redis.createClient(redisurl);

const asyncGet = util.promisify(client.get).bind(client);
const asyncSet = util.promisify(client.set).bind(client);
const asyncFlush = util.promisify(client.flushall).bind(client);
// 7200 sek í 2 klukkustundum
const cacheTtl = 7200;

/* todo require og stilla dót */

/**
 * Listi af sviðum með „slug“ fyrir vefþjónustu og viðbættum upplýsingum til
 * að geta sótt gögn.
 */
const departments = [
  {
    name: 'Félagsvísindasvið',
    slug: 'felagsvisindasvid',
    id: 1,
  },
  {
    name: 'Heilbrigðisvísindasvið',
    slug: 'heilbrigdisvisindasvid',
    id: 2,
  },
  {
    name: 'Hugvísindasvið',
    slug: 'hugvisindasvid',
    id: 3,
  },
  {
    name: 'Menntavísindasvið',
    slug: 'menntavisindasvid',
    id: 4,
  },
  {
    name: 'Verkfræði- og náttúruvísindasvið',
    slug: 'verkfraedi-og-natturuvisindasvid',
    id: 5,
  },
];

/**
 * Sækir svið eftir `slug`. Fáum gögn annaðhvort beint frá vef eða úr cache.
 *
 * @param {string} slug - Slug fyrir svið sem skal sækja
 * @returns {Promise} Promise sem mun innihalda gögn fyrir svið eða null ef það finnst ekki
 */
async function getTests(slug) {
  let myID;

  // finna ID sem passar við slug (úr departments)
  departments.forEach((obj) => {
    if (obj.slug === slug) {
      myID = obj.id;
    }
  });

  // skila null ef svið fannst ekki
  if (!myID) {
    return null;
  }

  const cached = await asyncGet(slug);

  // ef gögn eru til í cache skilum við þeim (eru geymd sem strengur, skilum json)
  if (cached) {
    return JSON.parse(cached);
  }

  const response = await fetch(`https://ugla.hi.is/Proftafla/View/ajax.php?sid=2027&a=getProfSvids&proftaflaID=37&svidID=${myID}&notaVinnuToflu=0`);
  const text = await response.text();

  const parsed = JSON.parse(text);

  const $ = cheerio.load(parsed.html);

  // Finnum öll h3
  const titleElements = $('table');

  // Fylki af objectum sem við skilum (verður 'tests')
  const department = [];

  // Fyrir hvert heading (deild)(h3)
  titleElements.each((i, el) => {
    // prev, gildið á undan töflunni er heading-ið fyrir töfluna
    const heading = $(el).prev().text();
    // test fylkið sem tilheyrir þessu heading
    const tests = [];

    // Förum nú inní töfluna
    const testbody = $(el).children('tbody').children('tr');

    // ítrum nú töfluna
    testbody.each((j, al) => {
      // Skilar okkur dálkunum í töflunni
      const tableTD = $(al).children('td');
      // breyturnar sem fara inní tests
      const course = tableTD.eq(0).text();
      const name = tableTD.eq(1).text();
      const type = tableTD.eq(2).text();
      const students = tableTD.eq(3).text();
      const date = tableTD.eq(4).text();

      // push í tests
      tests.push({
        course,
        name,
        type,
        students,
        date,
      });
    });

    // push-a deild (heading og tests) í fylkið sem við skilum
    department.push({
      heading,
      tests,
    });
  });

  // asyncSet þarf að taka inn streng
  const stringed = JSON.stringify(department);
  await asyncSet(slug, stringed, 'EX', cacheTtl);

  return department;
}

/**
 * Hreinsar cache.
 *
 * @returns {Promise} Promise sem mun innihalda boolean um hvort cache hafi verið hreinsað eða ekki.
 */
async function clearCache() {
  try {
    asyncFlush();
    return true;
  } catch (err) {
    console.error('Error clearing cache', err);
    return false;
  }
}

/**
 * Sækir tölfræði fyrir öll próf allra deilda allra sviða.
 *
 * @returns {Promise} Promise sem mun innihalda object með tölfræði um próf
 */
async function getStats() {
  const promiseTests = [];

  // fylla promiseTests af promises um deildir sem verða lesnar inn
  departments.forEach((obj) => {
    promiseTests.push(getTests(obj.slug));
  });

  // Bíða eftor að allar deildir(próf) séu lesin inn
  const readTests = await Promise.all(promiseTests);

  // Breytur sem verður skilað
  let min = Number.MAX_SAFE_INTEGER;
  let max = Number.MIN_SAFE_INTEGER;
  let numTests = 0;
  let numStudents = 0;

  // Ítra gegnum deildir-deild-námskeið
  readTests.forEach((Alldeparts) => {
    Alldeparts.forEach((depart) => {
      depart.tests.forEach((course) => {
        min = Math.min(min, course.students);
        max = Math.max(max, course.students);
        numTests += 1;
        numStudents += Number(course.students);
      });
    });
  });

  const averageStudents = (numStudents / numTests).toFixed(2);

  return {
    min,
    max,
    numTests,
    numStudents,
    averageStudents,
  };
}

module.exports = {
  departments,
  getTests,
  clearCache,
  getStats,
};
