const express = require("express");
const app = express();
require("dotenv").config();
const cors = require("cors");
const cookieParser = require("cookie-parser");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const jwt = require("jsonwebtoken");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

const port = process.env.PORT || 5000;

// middleware
const corsOptions = {
  origin: [
    "http://localhost:5173",
    "http://localhost:5174",
    "https://petlovershub-d9085.web.app",
    "https://pet-lovers-hub.netlify.app",
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
    const adoptingRequestPetCollection = db.collection("adoptingRequestPets");
    const donationCampaignCollection = db.collection("donationCampaigns");
    const donateInfoCollection = db.collection("donatesInfo");
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

    //? verify admin middleware
    const verifyAdmin = async (req, res, next) => {
      const user = req.user;
      const query = { email: user?.email };
      const result = await userCollection.findOne(query);
      if (!result || result?.role !== "admin")
        return res.status(401).send({ message: "unauthorized access!!" });
      next();
    };

    // create-payment-intent
    app.post("/create-payment-intent", verifyToken, async (req, res) => {
      const donateAmount = req.body.donateAmount;
      const donateAmountInCent = parseFloat(donateAmount) * 100;
      if (!donateAmount || donateAmountInCent < 1) return;
      // generate clientSecret
      const { client_secret } = await stripe.paymentIntents.create({
        amount: donateAmountInCent,
        currency: "usd",
        // In the latest version of the API, specifying the `automatic_payment_methods` parameter is optional because Stripe enables its functionality by default.
        automatic_payment_methods: {
          enabled: true,
        },
      });
      // send client secret as response
      res.send({ clientSecret: client_secret });
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
    app.get("/user/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.user.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const result = await userCollection.findOne({ email });
      res.send(result);
    });
    //? get all users from db
    app.get("/users", verifyToken, verifyAdmin, async (req, res) => {
      const result = await userCollection.find().toArray();
      res.send(result);
    });
    //? update a user role
    app.patch(
      "/users/update/:email",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const email = req.params.email;
        const userRole = req.body;
        const query = { email };
        const updateDoc = {
          $set: {
            ...userRole,
            timestamp: Date.now(),
          },
        };
        const result = await userCollection.updateOne(query, updateDoc);
        res.send(result);
      }
    );

    //* pet related api

    //? save a pet on db
    app.post("/pets", verifyToken, async (req, res) => {
      const petData = req.body;
      const result = await petCollection.insertOne(petData);
      res.send(result);
    });

    //? get all pets from db
    app.get("/pets", verifyToken, verifyAdmin, async (req, res) => {
      const result = await petCollection.find().toArray();
      res.send(result);
    });

    //? get all adoptable pets
    app.get("/adoptable-pets", async (req, res) => {
      const query = {
        adopted: false,
      };
      const result = await petCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();
      res.send(result);
    });

    //? get all available pets
    app.get("/available-pets", async (req, res) => {
      const { search = "", category = "", page = 0, limit = 3 } = req.query;

      // Base query
      const query = {
        adopted: false,
      };

      // Apply search to both petName and petCategory
      if (search) {
        query.$or = [
          { petName: { $regex: search, $options: "i" } },
          { petCategory: { $regex: search, $options: "i" } },
        ];
      }

      // If a category is selected, apply it as an exact match
      if (category) {
        query.petCategory = category;
      }

      const options = {
        sort: { createdAt: -1 },
        skip: parseInt(page) * parseInt(limit),
        limit: parseInt(limit),
      };

      try {
        const pets = await petCollection
          .find(query)
          .skip(options.skip)
          .limit(options.limit)
          .sort(options.sort)
          .toArray();

        const nextPage = pets.length < limit ? null : parseInt(page) + 1;
        res.json({ pets, nextPage });
      } catch (error) {
        console.error("Error fetching pets:", error);
        res.status(500).json({ error: "Internal Server Error" });
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
      if (email !== req.user.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const filter = { "presentOwner.email": email };
      const result = await petCollection.find(filter).toArray();
      res.send(result);
    });

    //? update pet adopted Status
    app.patch("/pet/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const { adopted } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { adopted: adopted },
      };
      const result = await petCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    //? update a pet by id
    app.put("/pet/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const petData = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: petData,
      };
      const result = await petCollection.updateOne(query, updateDoc);
      res.send(result);
    });

    //? delete a pet from db
    app.delete("/pet/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await petCollection.deleteOne(query);
      res.send(result);
    });

    //* adopting request pets related apis

    //? save pet adopting request
    app.post("/adopting-request-pets", verifyToken, async (req, res) => {
      const email = req.user.email;
      const adoptingData = req.body;
      const petId = adoptingData.petId;
      const query = { petId: petId, "requester.email": email };
      const isExist = await adoptingRequestPetCollection.findOne(query);
      if (isExist)
        return res
          .status(403)
          .send({ message: "You already requested for adopting this pet" });
      const result = await adoptingRequestPetCollection.insertOne(adoptingData);
      res.send(result);
    });

    //? get all adopting request pets for a for a single user
    app.get("/adopting-request-pets/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.user.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const filter = { "presentOwner.email": email };
      const result = await adoptingRequestPetCollection.find(filter).toArray();
      res.send(result);
    });

    //? clear the db after rejected or accepted
    app.delete("/adopting-request-pet/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const filter = { _id: new ObjectId(id) };
      const result = await adoptingRequestPetCollection.deleteOne(filter);
      res.send(result);
    });

    //* Donation Campaign Related apis

    //? save new created campaign in db
    app.post("/donation-campaigns", verifyToken, async (req, res) => {
      const campaignData = req.body;
      const result = await donationCampaignCollection.insertOne(campaignData);
      res.send(result);
    });

    //? get all created donations campaigns
    app.get("/donationCampaigns", async (req, res) => {
      const limit = parseInt(req?.query?.limit);
      const { id } = req.query;
      const filter = {
        pauseStatus: false,
      };
      if (id) {
        filter._id = { $ne: new ObjectId(id) }; // Assuming id is of type ObjectId
      }
      if (limit && limit) {
        const result = await donationCampaignCollection
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(limit)
          .toArray();
        res.send(result);
      } else {
        const result = await donationCampaignCollection.find().toArray();
        res.send(result);
      }
    });

    //? get all created campaigns
    app.get("/donation-campaigns", async (req, res) => {
      const { page = 0, limit = 3 } = req.query;
      const options = {
        sort: { createdAt: -1 },
        skip: parseInt(page) * parseInt(limit),
        limit: parseInt(limit),
      };

      try {
        const campaigns = await donationCampaignCollection
          .find()
          .skip(options.skip)
          .limit(options.limit)
          .sort(options.sort)
          .toArray(); // Log the fetched campaigns
        const nextPage = campaigns.length < limit ? null : parseInt(page) + 1;
        res.json({ campaigns, nextPage });
      } catch (error) {
        console.error("Error fetching pets:", error);
        res.status(500).json({ error: "Internal Server Error" });
      }
    });

    //? get all created campaigns by for a user
    app.get("/donation-campaigns/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      if (email !== req.user.email) {
        return res.status(403).send({ message: "forbidden access" });
      }
      const query = { "creator.email": email };
      const result = await donationCampaignCollection.find(query).toArray();
      res.send(result);
    });

    //? get a single campaign by a id
    app.get("/campaign/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await donationCampaignCollection.findOne(query);
      res.send(result);
    });

    //? update campaign Status
    app.patch("/updateStatus-campaign/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const { pauseStatus } = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: { pauseStatus: pauseStatus },
      };
      const result = await donationCampaignCollection.updateOne(
        query,
        updateDoc
      );
      res.send(result);
    });

    //? update campaign Data
    app.put("/update-campaign/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const campaignData = req.body;
      const query = { _id: new ObjectId(id) };
      const updateDoc = {
        $set: campaignData,
      };
      const result = await donationCampaignCollection.updateOne(
        query,
        updateDoc
      );
      res.send(result);
    });

    //? update campaign with Donators Data
    app.put(
      "/update-donateInfo-campaign/:id",
      verifyToken,
      async (req, res) => {
        const id = req.params.id;
        const updateCampaignData = req.body;
        const query = { _id: new ObjectId(id) };
        const option = { upsert: true };
        const updateDoc = {
          $set: updateCampaignData,
        };
        const result = await donationCampaignCollection.updateOne(
          query,
          updateDoc,
          option
        );
        res.send(result);
      }
    );

    //? delete a campaign by id
    app.delete(
      "/delete-campaign/:id",
      verifyToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const result = await donationCampaignCollection.deleteOne(query);
        res.send(result);
      }
    );

    //* Donation payment related apis

    //? save a new donated information
    app.post("/donates", verifyToken, async (req, res) => {
      const donateData = req.body;
      const result = await donateInfoCollection.insertOne(donateData);
      res.send(result);
    });
    app.get("/donates/:email", verifyToken, async (req, res) => {
      const email = req.params.email;
      const query = { "donator.email": email };
      const result = await donateInfoCollection.find(query).toArray();
      res.send(result);
    });

    //? handle refund data
    app.put("/refund-payment", verifyToken, async (req, res) => {
      const updateData = req.body;
      const _id = updateData?._id;
      const query1 = { _id: new ObjectId(_id) };
      const id = updateData?.campaignId;
      const query2 = { _id: new ObjectId(id) };

      const campaign = await donationCampaignCollection.findOne(query2);

      let donators = campaign?.donators || [];
      const transactionId = updateData?.donator?.transactionId || "";

      if (transactionId) {
        donators = donators.filter(
          (donator) => donator.transactionId !== transactionId
        );
      }

      const donatedAmount = parseFloat(
        parseFloat(campaign?.donatedAmount) -
          parseFloat(updateData?.donator?.donateAmount)
      );

      const updateCampaignDoc = {
        $set: {
          donators: donators,
          donatedAmount: donatedAmount,
        },
      };

      const updateCampaign = await donationCampaignCollection.updateOne(
        query2,
        updateCampaignDoc
      );
      const updatePaymentInfoDoc = {
        $set: {
          refund: true,
        },
      };
      const updatePaymentInfo = await donateInfoCollection.updateOne(
        query1,
        updatePaymentInfoDoc
      );

      const result = { updateCampaign, updatePaymentInfo };

      res.send(result);
    });

    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
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
