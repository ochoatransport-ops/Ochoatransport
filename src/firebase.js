import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyAiQnSXBUO2BAKhN4-Ai1C1G55SJgmy9BE",
  authDomain: "ochoatransport-77ee9.firebaseapp.com",
  projectId: "ochoatransport-77ee9",
  storageBucket: "ochoatransport-77ee9.firebasestorage.app",
  messagingSenderId: "302832831847",
  appId: "1:302832831847:web:3453b47ad12b4bedb7b3c2"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
