import { useEffect } from "react";
import Topbar from "../layout/Topbar";
import { supabase } from "../services/supabase";
import MuralAniversariantes from "../components/MuralAniversariantes";

export default function Dashboard() {
  useEffect(() => {
    async function load() {
      const { data, error } = await supabase
        .from("usuarios")
        .select("*");

      console.log("DADOS:", data);
      console.log("ERRO:", error);
    }

    load();
  }, []);

  return (
    <main className="content">
      <Topbar />

      <MuralAniversariantes />

      <h1>Dashboard ReATIVA One</h1>
    </main>
  );
}