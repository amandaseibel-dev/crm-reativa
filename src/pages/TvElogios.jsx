import { useEffect, useState } from "react";
import { supabase } from "../services/supabase";

const FONTE_TITULO = "'Sora', 'Inter', system-ui, sans-serif";
const SEGUNDOS_POR_ELOGIO = 12;
const SEGUNDOS_ATUALIZAR_LISTA = 60;

function formatarDataHora(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  } catch {
    return "";
  }
}

export default function TvElogios() {
  const [elogios, setElogios] = useState([]);
  const [indice, setIndice] = useState(0);
  const [urlAtual, setUrlAtual] = useState(null);
  const [carregando, setCarregando] = useState(true);

  useEffect(() => {
    carregar();
    const intervaloLista = setInterval(carregar, SEGUNDOS_ATUALIZAR_LISTA * 1000);
    return () => clearInterval(intervaloLista);
  }, []);

  useEffect(() => {
    if (elogios.length === 0) return;
    const intervaloTroca = setInterval(() => {
      setIndice((atual) => (atual + 1) % elogios.length);
    }, SEGUNDOS_POR_ELOGIO * 1000);
    return () => clearInterval(intervaloTroca);
  }, [elogios]);

  useEffect(() => {
    const atual = elogios[indice];
    if (!atual?.elogio_print_path) {
      setUrlAtual(null);
      return;
    }

    let ativo = true;
    supabase.storage
      .from("elogios-prints")
      .createSignedUrl(atual.elogio_print_path, 3600)
      .then(({ data }) => {
        if (ativo) setUrlAtual(data?.signedUrl || null);
      });

    return () => {
      ativo = false;
    };
  }, [indice, elogios]);

  async function carregar() {
    const { data, error } = await supabase
      .from("aluno_movimentacoes")
      .select("id, aluno_id, descricao, registrado_por_nome, registrado_em, elogio_print_path")
      .eq("tipo", "FINALIZACAO_ATENDIMENTO")
      .eq("status_novo", "ELOGIO_ATENDIMENTO")
      .eq("elogio_aprovado_tv", true)
      .order("registrado_em", { ascending: false })
      .limit(50);

    if (error) {
      console.error("Erro ao carregar elogios pra TV:", error);
      setCarregando(false);
      return;
    }

    const lista = data || [];
    const idsAlunos = [...new Set(lista.map((m) => m.aluno_id).filter(Boolean))];
    let nomesPorId = {};
    if (idsAlunos.length > 0) {
      const { data: alunos } = await supabase.from("alunos").select("id, nome").in("id", idsAlunos);
      nomesPorId = Object.fromEntries((alunos || []).map((a) => [String(a.id), a.nome]));
    }

    setElogios(lista.map((m) => ({ ...m, aluno_nome: nomesPorId[String(m.aluno_id)] || "Aluno" })));
    setCarregando(false);
    setIndice(0);
  }

  const atual = elogios[indice];

  if (carregando) {
    return <div style={estilos.container}><p style={estilos.vazioTexto}>Carregando...</p></div>;
  }

  if (elogios.length === 0) {
    return (
      <div style={estilos.container}>
        <div style={estilos.vazio}>
          <p style={estilos.vazioEmoji}>💚</p>
          <p style={estilos.vazioTexto}>Nenhum elogio aprovado pra TV ainda.</p>
        </div>
      </div>
    );
  }

  return (
    <div style={estilos.container}>
      <div style={estilos.cabecalho}>
        <span style={estilos.logo}>ReATIVA</span>
        <span style={estilos.titulo}>💚 Elogios de Atendimento</span>
      </div>

      <div style={estilos.corpo}>
        <div style={estilos.cardPrincipal}>
          {urlAtual ? (
            <img src={urlAtual} alt="Elogio" style={estilos.imagem} />
          ) : (
            <div style={estilos.semImagem}>
              <p style={{ fontSize: 60 }}>💬</p>
              <p style={{ fontSize: 22, opacity: 0.7 }}>{atual?.descricao || "Elogio registrado"}</p>
            </div>
          )}
        </div>

        <div style={estilos.infoInferior}>
          <div>
            <p style={estilos.nomeAluno}>{atual?.aluno_nome}</p>
            <p style={estilos.meta}>
              Atendido por <strong>{atual?.registrado_por_nome}</strong> · {formatarDataHora(atual?.registrado_em)}
            </p>
          </div>

          <div style={estilos.pontos}>
            {elogios.map((_, i) => (
              <span key={i} style={i === indice ? estilos.pontoAtivo : estilos.ponto} />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const estilos = {
  container: {
    position: "fixed",
    inset: 0,
    background: "linear-gradient(160deg, #06110c 0%, #0d1f16 50%, #06110c 100%)",
    color: "#fff",
    fontFamily: "'Inter', system-ui, sans-serif",
    display: "flex",
    flexDirection: "column",
    padding: "40px 60px",
    boxSizing: "border-box",
  },
  cabecalho: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: 30,
  },
  logo: { fontFamily: FONTE_TITULO, fontSize: 22, fontWeight: 800, color: "#22c55e" },
  titulo: { fontFamily: FONTE_TITULO, fontSize: 28, fontWeight: 800 },
  corpo: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 30,
  },
  cardPrincipal: {
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(34,197,94,0.25)",
    borderRadius: 24,
    padding: 24,
    maxWidth: "80vw",
    maxHeight: "62vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 30px 90px rgba(0,0,0,0.4)",
  },
  imagem: { maxWidth: "100%", maxHeight: "58vh", borderRadius: 14, objectFit: "contain" },
  semImagem: { textAlign: "center", padding: 60 },
  infoInferior: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 16,
    textAlign: "center",
  },
  nomeAluno: { fontFamily: FONTE_TITULO, fontSize: 34, fontWeight: 800, margin: 0 },
  meta: { fontSize: 18, color: "#9ca3af", margin: "6px 0 0" },
  pontos: { display: "flex", gap: 8 },
  ponto: { width: 8, height: 8, borderRadius: "50%", background: "rgba(255,255,255,0.2)" },
  pontoAtivo: { width: 24, height: 8, borderRadius: 999, background: "#22c55e", transition: "width 0.2s ease" },
  vazio: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" },
  vazioEmoji: { fontSize: 60, margin: 0 },
  vazioTexto: { fontSize: 22, color: "#9ca3af" },
};
