import { useState, useEffect, useRef } from "react";
import { supabase } from "../services/supabase";

const INTERVALO_MS = 60_000;
const SS_KEY = "ulbra_leads_vistos";

function carregarVistos() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function salvarVistos(set) {
  try {
    sessionStorage.setItem(SS_KEY, JSON.stringify([...set]));
  } catch {
    // sessionStorage indisponível — continua sem persistência
  }
}

export default function NotificacoesUlbra({ onAssumirLead }) {
  const [leads, setLeads] = useState([]);
  const [aberto, setAberto] = useState(false);
  const vistoRef = useRef(carregarVistos());

  useEffect(() => {
    let ativo = true;

    const buscar = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const token = session?.access_token;
        if (!token || !ativo) return;

        const resp = await fetch(
          `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ulbra-leads-pendentes`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!ativo) return;
        const dados = await resp.json();

        if (dados.motivo === "NAO_RECEPTIVO") return;

        const chegando = dados.leads ?? [];
        const idsAtuais = new Set(chegando.map((l) => l.id));

        // Detectar leads genuinamente novos (não notificados ainda)
        const novos = chegando.filter((l) => !vistoRef.current.has(l.id));
        novos.forEach((l) => vistoRef.current.add(l.id));

        // Limpar IDs que saíram do waiting — permitem re-notificação se retornarem
        for (const id of vistoRef.current) {
          if (!idsAtuais.has(id)) vistoRef.current.delete(id);
        }
        if (novos.length > 0) salvarVistos(vistoRef.current);

        // Lista operacional = sempre todos os atendimentos waiting em escopo
        // Independente do vistoRef — um lead ainda pendente nunca some da operação
        setLeads(chegando);
      } catch {
        // silencioso — não bloquear a interface
      }
    };

    buscar();
    const id = setInterval(buscar, INTERVALO_MS);
    return () => { ativo = false; clearInterval(id); };
  }, []);

  if (leads.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setAberto((v) => !v)}
        className="relative text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 px-3 py-1 rounded"
      >
        Mensageria Ulbra
        <span className="ml-1 bg-red-500 text-white text-xs rounded-full px-1.5">
          {leads.length}
        </span>
      </button>

      {aberto && (
        <div className="absolute right-0 mt-1 w-72 bg-white border rounded shadow-lg z-50">
          <div className="p-2 text-xs font-semibold text-gray-500 border-b">
            Novos leads receptivos
          </div>
          {leads.map((lead) => (
            <div key={lead.id} className="p-2 flex items-center justify-between hover:bg-gray-50">
              <span className="text-sm truncate">{lead.nome}</span>
              <button
                onClick={() => {
                  onAssumirLead?.(lead);
                  setAberto(false);
                }}
                className="ml-2 text-xs text-blue-600 hover:underline whitespace-nowrap"
              >
                Assumir
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
