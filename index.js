const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");

const port = process.env.PORT || 3000;

// middleware
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://petlovershub-d9085.web.app",
  ],
  credentials: true,
  optionSuccessStatus: 200,
};
app.use(cors(corsOptions));

app.use(express.json());
app.use(cookieParser());

// Verify Token Middleware
const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token;
  // console.log(token);
  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err?.message);
      return res.status(401).send({ message: "unauthorized access" });
    }
    req.user = decoded;
    next();
  });
};

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.irefuhm.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    const db = client.db("petLoversHubDB");
    const userCollection = db.collection("users");
    const petCollection = db.collection("pets");
    //* auth related api
    app.post("/jwt", async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: "365d",
      });
      res
        .cookie("token", token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
        })
        .send({ success: true });
    });
    //? Logout
    app.get("/logout", async (req, res) => {
      try {
        res
          .clearCookie("token", {
            maxAge: 0,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
          })
          .send({ success: true });
        // console.log("Logout successful");
      } catch (err) {
        res.status(500).send(err);
      }
    });

    //* user related apis

    //? save user data in db
    app.put("/user", async (req, res) => {
      const user = req.body;
      const query = { email: user?.email };
      // check if user already exists in db
      const isExist = await userCollection.findOne(query);
      // if (isExist) return res.send(isExist);
      if (isExist) {
        if (user?.status === "Requested") {
          // if existing user try to change his role
          const result = await userCollection.updateOne(query, {
            $set: { status: user?.status },
          });
          return res.send(result);
        } else {
          // if existing user login again
          return res.send(isExist);
        }
      }

      // save user for the first time
      const options = { upsert: true };
      const updateDoc = {
        $set: {
          ...user,
          timestamp: Date.now(),
        },
      };
      const result = await userCollection.updateOne(query, updateDoc, options);
      res.send(result);
    });
    //? get user info by email from db
    app.get("/user/:email", async (req, res) => {
      const email = req.params.email;
      const result = await userCollection.findOne({ email });
      res.send(result);
    });

    //* pet related api

    //? save a pet on db
    app.post("/pets", verifyToken, async (req, res) => {
      const petData = req.body;
      const result = await petCollection.insertOne(petData);
      res.send(result);
    });

    //? get all pets from db
    app.get("/pets", async (req, res) => {
      const result = await petCollection.find().toArray();
      res.send(result);
    });

    // Todo: Have a problem infinite scrolling problems
    //? get all pets which is available for adopting from db
    app.get("/available-pets", async (req, res) => {
      const { page = 1, search = "", category = null } = req.query;
      const pageSize = 6;
      const query = {
        adopted: false,
        $or: [
          { petName: new RegExp(search, "i") },
          { petCategory: new RegExp(search, "i") },
        ],
      };
      if (category) {
        query.petCategory = category;
      }
      const options = { sort: { createdAt: -1 } };

      try {
        const pets = await petCollection
          .find(query, options)
          .skip((page - 1) * pageSize)
          .limit(pageSize)
          .toArray();

        const totalPets = await petCollection.countDocuments(query);
        const hasNextPage = page * pageSize < totalPets;

        res.json({
          pets,
          hasNextPage,
        });
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    //? get a pet from db
    app.get("/pet/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await petCollection.findOne(query);
      res.send(result);
    });

    //? get all pets for a single user from db
    app.get("/pets/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (req.params.email !== req.user.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const filter = { "presentOwner.email": email };
      const result = await petCollection.find(filter).toArray();
      res.send(result);
    });

    // update pet adopted Status
    app.patch("/pet/:id", async (req, res) => {
      const id = req.params.id;
      const adopted = req.body.adopted;
      // make pet adopted status true
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { adopted: adopted },
      };
      const result = await petCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    //? delete a pet from db
    app.delete("/pet/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await petCollection.deleteOne(query);
      res.send(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Hello from PetLoversHub Server..");
});

app.listen(port, () => {
  console.log(`PetLoversHub is running on port ${port}`);
});
