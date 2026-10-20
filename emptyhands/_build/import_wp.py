"""One-off importer: turns the WordPress REST export of emptyhands.co.uk posts
into clean, self-contained HTML fragments in content/posts.json.

Usage: python3 import_wp.py <posts.json from /wp-json/wp/v2/posts?per_page=100>
"""
import html
import json
import os
import re
import sys
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
IMGMAP = json.load(open(os.path.join(HERE, 'content', 'imgmap.json')))
UPLOADS = 'https://emptyhands.co.uk/wp-content/uploads/'

# Older duplicates of newer posts on the original site.
DROP = {'blog-3', 'blog-5', 'chi-2', 'trainee-instructors'}

CATEGORY = {
    'karate_rules': 'Karate', 'budo-culture': 'Karate', 'evidence-based-karate-training': 'Karate',
    'shotokan-tigers': 'Karate', 'karate-mindsets': 'Karate', 'neurobics-for-karate': 'Karate',
    '5-actionable-tips-to-becoming-a-better-karateka': 'Karate', 'kobudo': 'Karate',
    'fight-club': 'Karate', 'bodhidharma-founder-of-martial-arts': 'History',
    'history-of-karate-do': 'History', 'chi': 'Wellbeing', 'immunity-tips': 'Wellbeing',
    'yoga-karate': 'Wellbeing', 'coping-with-stress-is-karate-the-answer': 'Wellbeing',
    'sports-injuries': 'Wellbeing', 'clinic': 'Wellbeing', 'sotai-master-class-with-rex-lassalle': 'Wellbeing',
    'reflections-learning-from-lockdown': 'Wellbeing', 'virtual-dojo': 'Dojo life',
    'creating-online-dojo-with-microsoft-teams': 'Dojo life', 'coronavirus-online-karate-training': 'Dojo life',
    'trainee-instructors': 'Dojo life', 'warm-up': 'Dojo life', 'emptyhands-charity-cup': 'Dojo life',
    'workshop-with-shihan-chris-rowen': 'Dojo life',
}

COVER = {
    'karate_rules': '2024/02/Karate-Syllabus.jpg', 'budo-culture': '2024/05/BudoArt.jpg',
    'evidence-based-karate-training': '2024/05/eh-students_q.jpg',
    'shotokan-tigers': '2024/05/shotokan-tiger.png', 'karate-mindsets': '2024/06/Leila2_edited.jpg',
    'neurobics-for-karate': '2024/05/yinyang-1.png',
    '5-actionable-tips-to-becoming-a-better-karateka': '2024/05/image.png',
    'coping-with-stress-is-karate-the-answer': '2024/06/zazen.webp', 'kobudo': '2024/05/Jo-Kabudo.jpg',
    'immunity-tips': '2024/05/5-Element-theory.jpg',
    'fight-club': '2025/08/homekarate.jpg',
    'coronavirus-online-karate-training': '2024/05/image-1.png', 'yoga-karate': '2024/05/Yoga-Studio.jpg',
    'virtual-dojo': '2024/05/EHTEAMS-1.jpg', 'chi': '2024/05/yinyang.png',
    'trainee-instructors': '2024/05/eh-students_q.jpg',
    'bodhidharma-founder-of-martial-arts': '2024/05/bodhidharma.jpg', 'clinic': '2024/05/kidney27.jpg',
    'warm-up': '2025/08/homekarate.jpg', 'sotai-master-class-with-rex-lassalle': '2024/05/image-1-1.png',
    'workshop-with-shihan-chris-rowen': '2024/02/azeem-mushtaq-sensei.jpg',
    'emptyhands-charity-cup': '2024/05/Shotokan-Tigers.jpg',
    'sports-injuries': '2024/06/image-1024x499-1.png', 'history-of-karate-do': '2024/05/image-2.png',
    'reflections-learning-from-lockdown': '2024/04/AMushtaqSensei.jpg',
    'creating-online-dojo-with-microsoft-teams': '2024/02/OnlineDojo-768x512-1.jpg',
}

# Placeholder text the original site never filled in.
FIXUPS = [
    ('[City]', 'Ilford'),
    ('we have proudly raised over [amount] for various causes', 'we have proudly raised money for a variety of causes'),
    ('The funds raised have been used to support projects such as:', ''),
]

KEEP = {'p', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'strong', 'em', 'a', 'img', 'figure', 'figcaption',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote', 'br', 'hr'}
RENAME = {'b': 'strong', 'i': 'em'}
VOID = {'img', 'br', 'hr'}


def local_image(url):
    """Map an uploads URL (any size variant) to its local webp, or None."""
    if not url or not url.startswith(UPLOADS):
        return None
    rel = url[len(UPLOADS):].split('?')[0]
    if rel in IMGMAP:
        return IMGMAP[rel]
    base = re.sub(r'-\d+x\d+(-\d+)?(?=\.\w+$)', '', rel)
    for k in IMGMAP:
        if re.sub(r'(-\d+x\d+)?(-\d+)?(?=\.\w+$)', '', k) == re.sub(r'(-\d+)?(?=\.\w+$)', '', base):
            return IMGMAP[k]
    return None


def local_link(href, slugs):
    m = re.match(r'https?://(?:www\.)?emptyhands\.co\.uk/([^/?#]+)/?$', href or '')
    if not m:
        return href
    slug = m.group(1)
    if slug in slugs:
        return slug + '.html'
    pages = {'contact': 'contact', 'register-for-classes': 'join', 'fees': 'fees', 'aboutus': 'about',
             'instructors': 'instructors', 'yudansha-wall': 'yudansha', 'blog': 'blog/index'}
    return '../%s.html' % pages.get(slug, 'index')


class Cleaner(HTMLParser):
    def __init__(self, slugs):
        super().__init__(convert_charrefs=True)
        self.out, self.stack, self.slugs, self.skip = [], [], slugs, 0

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag in ('script', 'style', 'iframe'):
            self.skip += 1
            return
        tag = RENAME.get(tag, tag)
        if tag not in KEEP:
            self.stack.append(None)
            return
        if tag == 'a':
            href = a.get('href', '')
            # The original site wrapped the word "karate" in SEO links to other clubs and pages.
            if 'granthamkarate' in href or 'karate_rules' in href or not href or href.startswith('#'):
                self.stack.append(None)
                return
            href = local_link(href, self.slugs)
            ext = href.startswith('http')
            self.out.append('<a href="%s"%s>' % (html.escape(href), ' target="_blank" rel="noopener"' if ext else ''))
        elif tag == 'img':
            img = local_image(a.get('src'))
            if img:
                self.out.append('<img src="../assets/img/%s" width="%d" height="%d" alt="%s" loading="lazy">'
                                % (img['file'], img['w'], img['h'], html.escape(a.get('alt') or '')))
            return
        else:
            self.out.append('<%s>' % tag)
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in ('script', 'style', 'iframe'):
            self.skip -= 1
            return
        tag = RENAME.get(tag, tag)
        if tag in VOID or not self.stack:
            return
        t = self.stack.pop()
        if t:
            self.out.append('</%s>' % t)

    def handle_data(self, data):
        if not self.skip:
            self.out.append(html.escape(data, quote=False))


def clean(raw, slugs):
    c = Cleaner(slugs)
    c.feed(raw)
    s = ''.join(c.out)
    for old, new in FIXUPS:
        s = s.replace(old, new)
    s = re.sub(r'\s+', ' ', s)
    s = re.sub(r'<(p|h\d|li|strong|em|figure)>\s*</\1>', '', s)
    s = re.sub(r'<(p|h\d|li)>\s*</\1>', '', s)
    s = re.sub(r'\s*(</?(?:p|h\d|ul|ol|li|figure|table|tbody|thead|tr|blockquote)>)\s*', r'\1', s)
    s = re.sub(r'(</(?:p|h\d|ul|ol|figure|table|blockquote)>)', r'\1\n', s)
    return s.strip()


def text_of(fragment):
    return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', fragment))).strip()


def main(path):
    raw = [p for p in json.load(open(path)) if p['slug'] not in DROP]
    slugs = {p['slug'] for p in raw}
    posts = []
    for p in raw:
        body = clean(p['content']['rendered'], slugs)
        text = text_of(body)
        words = len(text.split())
        excerpt = text if len(text) < 170 else text[:160].rsplit(' ', 1)[0] + '…'
        cover = IMGMAP.get(COVER.get(p['slug'], ''))
        posts.append({
            'slug': p['slug'],
            'title': html.unescape(p['title']['rendered']),
            'date': p['date'][:10],
            'category': CATEGORY.get(p['slug'], 'Karate'),
            'excerpt': excerpt,
            'minutes': max(1, round(words / 220)),
            'cover': cover,
            'html': body,
        })
    posts.sort(key=lambda x: x['date'], reverse=True)
    json.dump(posts, open(os.path.join(HERE, 'content', 'posts.json'), 'w'), indent=1, ensure_ascii=False)
    print('%d posts written' % len(posts))


if __name__ == '__main__':
    main(sys.argv[1])
