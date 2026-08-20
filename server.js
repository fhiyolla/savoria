require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const session = require('express-session');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const db= new Database('savoria.db');

const app = express();
app.use(express.json());
const storage = multer.diskStorage({

 destination:(req,file,cb)=>{
     cb(null,'public/images/');
 },

 filename:(req,file,cb)=>{
     cb(
       null,
       Date.now() +
       path.extname(file.originalname)
     );
 }

});

const upload = multer({storage});


// --- DB SETUP ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'user',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS cart (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  item_name TEXT NOT NULL,
  item_price REAL NOT NULL,
  item_image TEXT,
  category TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  total REAL NOT NULL,
  payment_method TEXT,
  status TEXT DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  rating INTEGER NOT NULL,
  message TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    food_name TEXT,
    price REAL,
    category TEXT
);
CREATE TABLE IF NOT EXISTS admin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT DEFAULT 'admin',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

`);

(async () => {
 const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);

  const user = db.prepare(
    "SELECT * FROM users WHERE username = ?"
  ).get("admin");

  if (!user) {
    db.prepare(`
      INSERT INTO users (username, password, role)
      VALUES (?, ?, ?)
    `).run("admin", hash, "admin");

    console.log("Admin created");
  }
})();

// --- MIDDLEWARE ---
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: 'savoria-secret-2024',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {

  if (!req.session.user ||
      req.session.user.role !== 'admin') {

    return res.send('Access denied');
  }

  next();
}

// --- AUTH ROUTES ---
app.post('/api/register', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.json({ success: false, message: 'Missing fields' });
  }

  const existingUser = db
    .prepare('SELECT * FROM users WHERE username = ?')
    .get(username);

  if (existingUser) {
    return res.json({ success: false, message: 'Username already exists' });
  }

  const hashed = bcrypt.hashSync(password, 10);

  db.prepare('INSERT INTO users (username, password) VALUES (?, ?)')
    .run(username, hashed);

  res.json({ success: true });
});

app.post("/login", (req, res) => {

    const { username, password } = req.body;

    const user = db.prepare(
        "SELECT * FROM users WHERE username = ?"
    ).get(username);

    if (!user) {

        return res.json({
            success: false,
            message: "User not found"
        });

    }

    const valid = bcrypt.compareSync(
        password,
        user.password
    );

    if (!valid) {

        return res.json({
            success: false,
            message: "Wrong password"
        });

    }

    res.json({
        success: true,
        role: user.role
    });

});
app.post("/api/signup", async (req, res) => {

    try {

        const { name, email, phone, password } = req.body;

        if (!name || !email || !phone || !password) {
            return res.json({
                success: false,
                message: "Fill all fields"
            });
        }

        const existingUser = db.prepare(
            "SELECT * FROM users WHERE username = ?"
        ).get(name);

        if (existingUser) {
            return res.json({
                success: false,
                message: "User already exists"
            });
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        db.prepare(`
            INSERT INTO users (username, password, role)
            VALUES (?, ?, ?)
        `).run(name, hashedPassword, "user");

        res.json({
            success: true
        });

    } catch (err) {

        console.log(err);

        res.json({
            success: false
        });
    }

});
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// --- CART ROUTES ---
app.post('/api/cart/add', (req, res) => {
  const { item_name, item_price, item_image, category } = req.body;
  const sid = req.session.id;
  const username = req.session.user?.username || 'Guest';
  db.prepare('INSERT INTO cart (session_id, item_name, item_price, item_image, category) VALUES (?, ?, ?, ?, ?)')
    .run(sid, item_name, item_price, item_image || '', category || '');
  res.json({ success: true });
});

app.get('/api/cart', (req, res) => {
  const items = db.prepare('SELECT * FROM cart WHERE session_id = ?').all(req.session.id);
  res.json({ success: true, items });
});

app.delete('/api/cart/:id', (req, res) => {
  db.prepare('DELETE FROM cart WHERE id = ? AND session_id = ?').run(req.params.id, req.session.id);
  res.json({ success: true });
});

app.delete('/api/cart', (req, res) => {
  db.prepare('DELETE FROM cart WHERE session_id = ?').run(req.session.id);
  res.json({ success: true });
});
app.post('/api/cart/remove', (req,res)=>{

 const { item_name } =
 req.body;

 db.prepare(`
 DELETE FROM cart
 WHERE id = (

   SELECT id
   FROM cart

   WHERE item_name=?
   AND session_id=?

   ORDER BY id DESC
   LIMIT 1

 )
 `).run(
 item_name,
 req.session.id
 );

 res.json({
 success:true
 });

});
// --- ORDER ROUTES ---
app.post('/api/orders', (req, res) => {

  const { total, payment_method } = req.body;
  const sid = req.session.id;

  const indiaTime = new Date().toLocaleString(
    "en-IN",
    { timeZone: "Asia/Kolkata" }
  );
  db.prepare(`
    INSERT INTO orders
    (session_id, total, payment_method, status, created_at)
    VALUES (?, ?, ?, ?, ?)
`).run(
    sid,
    total,
    payment_method,
    'confirmed',
    indiaTime
);


  db.prepare(
    'DELETE FROM cart WHERE session_id = ?'
  ).run(sid);

  res.json({ success:true });

});

// --- FEEDBACK ROUTES ---
app.post('/api/feedback', (req, res) => {
  const { rating, message } = req.body;
  db.prepare('INSERT INTO feedback (session_id, rating, message) VALUES (?, ?, ?)')
    .run(req.session.id, rating, message || '');
  res.json({ success: true });
});
// --- ADMIN ROUTES ---

app.get('/api/admin/users', (req, res) => {
  const users = db.prepare('SELECT username, role FROM users').all();
  res.json(users);
});

app.get('/api/admin/orders', (req, res) => {
  const orders = db.prepare('SELECT * FROM orders ORDER BY id DESC').all();
  res.json(orders);
});

app.get('/api/admin/feedback', (req, res) => {
  const feedback = db.prepare(
    'SELECT * FROM feedback ORDER BY id DESC'
  ).all();

  res.json(feedback);
});
app.get('/delete-orders', (req, res) => {

    db.prepare(`
        DELETE FROM orders
    `).run();

    res.send('Orders deleted');

});
app.delete('/api/admin/delete-all-dishes', (req, res) => {

    db.prepare(`
        DELETE FROM dishes
    `).run();

    res.json({
        success: true
    });

});
// --- PAGE ROUTES ---
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, 'public', 'home.html')));
app.get('/menu', (req, res) => res.sendFile(path.join(__dirname, 'public', 'menu.html')));
app.get('/signup', (req, res) => res.sendFile(path.join(__dirname, 'public', 'signup.html')));
app.get('/order', (req, res) => res.sendFile(path.join(__dirname, 'public', 'order.html')));
app.get('/payment', (req, res) => res.sendFile(path.join(__dirname, 'public', 'payment.html')));
app.get('/feedback', (req, res) => res.sendFile(path.join(__dirname, 'public', 'feedback.html')));

db.prepare(`
CREATE TABLE IF NOT EXISTS dishes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    price INTEGER,
    image TEXT,
    category TEXT
)
`).run();
const count =
db.prepare(
'SELECT COUNT(*) as c FROM dishes'
).get();


app.post('/api/admin/add-dish',
upload.single('image'),

(req,res)=>{

const { name, price, category } = req.body;

if (!name || !price || Number(price) <= 0) {
  return res.json({
    success:false,
    message:'Price must be greater than 0'
  });
}

const image =
'/images/' + req.file.filename;

db.prepare(`
 INSERT INTO dishes
 (name,price,image,category)
 VALUES(?,?,?,?)
`).run(
   name,
   price,
   image,
   category
);

res.json({
 success:true
});

});
app.put('/api/admin/update-dish/:id',
upload.single('image'),

(req,res)=>{

const { name, price, category } = req.body;

const image = req.file
    ? '/images/' + req.file.filename
    : req.body.image;

db.prepare(`
UPDATE dishes
SET
name=?,
price=?,
category=?,
image=?
WHERE id=?
`).run(
name,
price,
category,
image,
req.params.id
);

res.json({
 success:true
});

});

app.get('/api/dishes', (req,res)=>{

 const dishes =
 db.prepare(`
   SELECT * FROM dishes
 `).all();

 res.json(dishes);

});
app.post('/api/admin/import-default-dishes',(req,res)=>{

const dishes = [

['Butter Chicken',299,'images/butter-chicken.jpeg','indian'],
['Paneer Tikka',249,'images/paneer-tikka.jpeg','indian'],
['Dal Makhani',199,'images/dal-makhani.jpeg','indian'],
['Biryani Royal',349,'images/biriyani-royal.jpeg','indian'],
['Palak Paneer',229,'images/palak-paneer.jpeg','indian'],
['Chole Bhature',179,'images/chole-bhature.jpeg','indian'],

['Dim Sum Basket',279,'images/dim-sum.jpeg','chinese'],
['Kung Pao Noodles',249,'images/kung-pao-noodles.jpeg','chinese'],
['Spring Rolls',199,'images/spring-rolls.jpeg','chinese'],
['Fried Rice Lotus',229,'images/fried-rice.jpeg','chinese'],
['Manchurian Bowl',219,'images/manchurian.jpeg','chinese'],
['Sesame Tofu',259,'images/sesame-tofu.jpeg','chinese'],

['Bibimbap',319,'images/bibimbap.jpeg','korean'],
['Kimchi Jjigae',299,'images/kimchi.jpeg','korean'],
['Korean Fried Chicken',349,'images/korean-chicken.jpeg','korean'],
['Japchae',269,'images/japchae.jpeg','korean'],
['Tteokbokki',229,'images/tteokbokki.jpeg','korean'],
['Sundubu Jjigae',289,'images/sundubu.jpeg','korean'],

['Katsudon',199,'/images/katsudon.jpeg','japanese'],
['Sushi',399,'/images/sushi.jpeg','japanese'],
['Ramen',299,'/images/ramen.jpeg','japanese'],
['Takoyaki',200,'/images/takoyaki.jpeg','japanese'],
['Mega Sushi Plate',599,'/images/mega-sushi.jpeg','japanese'],
['Onigiri',100,'/images/onigiri.jpeg','japanese'],

['tiramisu',249,'/images/tirrrr.jpeg','Dessert'],
['Cheesecake',229,'/images/cheesecake.jpeg','Dessert'],
['Brownie Sundae',199,'/images/brownie.jpeg','Dessert'],
['Waffles',140,'/images/waffle.jpeg','Dessert'],
['sanrio',299,'/images/sanss.jpg','Dessert'],
['Tiramisu',279,'/images/tiramisu.jpeg','Dessert'],
];

const insert =
db.prepare(`
INSERT INTO dishes
(name,price,image,category)
VALUES(?,?,?,?)
`);

for(const d of dishes){

const exists =
db.prepare(`
SELECT id
FROM dishes
WHERE name=?
`).get(d[0]);

if(!exists){
insert.run(...d);
}

}

res.json({
success:true
});

});
db.prepare(`
UPDATE dishes
SET category='indian'
WHERE category='Indian'
`).run();
app.delete('/api/admin/delete-dish/:id',(req,res)=>{

 db.prepare(`
 DELETE FROM dishes
 WHERE id = ?
 `).run(req.params.id);

 res.json({success:true});

});
app.delete('/api/admin/delete-dish/:id',

(req,res)=>{

 const id =
 Number(req.params.id);

 db.prepare(`
 DELETE FROM dishes
 WHERE id = ?
 `).run(id);

 res.json({
 success:true
 });

});
app.delete(
'/api/admin/delete-order/:id',
(req,res)=>{

db.prepare(`
DELETE FROM orders
WHERE id=?
`).run(req.params.id);

res.json({
success:true
});

});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
