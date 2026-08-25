import { useCallback, useEffect, useState } from "react";
import { supabase } from "../services/supabase";

// Atualização cadastral pela Ulbra Prime.
//
// POR QUE É UM BOTÃO E NÃO UM CRON: agendar exigiria guardar a service key no
// Vault do projeto, e ele hoje só tem `projeto_url`. Com o botão, quem dispara
// é a sessão da própria gestão -- ninguém precisa manipular chave. A Edge
// Function confere `usuario_e_gestao()` com o token de quem chamou antes de
// tocar na API.
//
// POR QUE EM LOTES: a Prime cobra 2 a 3 requisições por aluno. Rodar a base
// inteira de uma vez é pedir 503. O lote deixa a gestão dosar.

const NUM = (v) => new Intl.NumberFormat("pt-BR").format(Number(v) || 0);

function Numero({ rot, val, destaque }) {
  return (
    <div style={{ ...S.numero, ...(destaque ? S.numeroDestaque : null) }}>
      <span style={S.numeroRot}>{rot}</span>
      <strong style={S.numeroVal}>{val}</strong>
    </div>
  );
}

export default function AtualizacaoCadastral() {
  const [resumo, setResumo] = useState(null);
  const [erro, setErro] = useState("");
  const [lote, setLote] = useState(50);
  const [rodando, setRodando] = useState(false);
  const [resultado, setResultado] = useState(null);

  const carregarResumo = useCallback(async () => {
    const { data, error } = await supabase.rpc("prime_cadastro_resumo");
    if (error) { setErro(error.message); return; }
    setErro("");
    setResumo(data || null);
  }, []);

  useEffect(() => { carregarResumo(); }, [carregarResumo]);

  async function rodar() {
    setRodando(true);
    setResultado(null);
    setErro("");
    try {
      const { data, error } = await supabase.functions.invoke("prime-cadastro", {
        body: { limite: Number(lote) || 50 },
      });
      if (error) {
        // A função devolve 403 com `ACESSO_NEGADO` para quem não é gestão.
        setErro(error.message || "Falha ao chamar a atualização.");
        return;
      }
      setResultado(data || null);
      carregarResumo();
    } finally {
      setRodando(false);
    }
  }

  const r = resumo || {};
  const ultima = r.ultima_coleta ? new Date(r.ultima_coleta).toLocaleString("pt-BR") : null;

  return (
    <div style={S.pagina}>
      <h1 style={S.titulo}>🔄 Atualização Cadastral (Prime)</h1>
      <p style={S.subtitulo}>
        Busca na Ulbra Prime os telefones, contratos e o semestre de cada dívida dos alunos com
        saldo em aberto. Os telefones <strong>entram somando</strong>: número novo não apaga o
        antigo, e número que alguém invalidou na ficha não volta.
      </p>

      <div style={S.grade}>
        <Numero rot="Devedores na base" val={NUM(r.devedores)} />
        <Numero rot="Pendentes de coleta" val={NUM(r.pendentes)} destaque />
        <Numero rot="Coletados (7 dias)" val={NUM(r.ja_coletados)} />
        <Numero rot="Contratos guardados" val={NUM(r.contratos)} />
        <Numero rot="Títulos com semestre" val={NUM(r.titulos_com_semestre)} />
        <Numero rot="Contatos vindos da Prime" val={NUM(r.contatos_da_prime)} />
      </div>

      {ultima ? <p style={S.rodape}>Última coleta: {ultima}</p> : null}

      <div style={S.caixaAcao}>
        <label style={S.label}>
          Alunos por rodada
          <select style={S.select} value={lote} onChange={(e) => setLote(e.target.value)} disabled={rodando}>
            {[10, 25, 50, 100, 200, 500].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
        <button style={{ ...S.botao, ...(rodando ? S.botaoDesativado : null) }} onClick={rodar} disabled={rodando}>
          {rodando ? "Atualizando…" : "Atualizar agora"}
        </button>
        <span style={S.aviso}>
          Vai do maior saldo para o menor. Quem já foi coletado só volta depois de 7 dias.
        </span>
      </div>

      {rodando ? (
        <p style={S.rodando}>
          Rodando. Um lote de {NUM(lote)} leva alguns minutos — a Prime é consultada aluno a aluno.
          Pode deixar a aba aberta.
        </p>
      ) : null}

      {erro ? <p style={S.erro}>{erro}</p> : null}

      {resultado ? (
        <div style={S.resultado}>
          <strong style={S.resultadoTitulo}>Resultado da rodada</strong>
          <div style={S.grade}>
            <Numero rot="Alunos pedidos" val={NUM(resultado.pedidos)} />
            <Numero rot="Atualizados" val={NUM(resultado.aplicados)} destaque />
            <Numero rot="Telefones novos" val={NUM(resultado.telefones_novos)} />
            <Numero rot="E-mails novos" val={NUM(resultado.emails_novos)} />
            <Numero rot="Títulos classificados" val={NUM(resultado.titulos_classificados)} />
            <Numero rot="Fora dos portadores" val={NUM(resultado.fora_do_escopo)} />
            <Numero rot="Erros" val={NUM(resultado.erros)} />
          </div>
          {Number(resultado.emails_novos) === 0 ? (
            <p style={S.nota}>
              E-mail zerado é o esperado: a Prime não devolve e-mail. O campo na ficha aceita
              vários, mas o dado vem do operador.
            </p>
          ) : null}
          {Number(resultado.fora_do_escopo) > 0 ? (
            <p style={S.nota}>
              “Fora dos portadores” são alunos que não aparecem no 166 nem no 195 — não são
              carteira da Reativa e por isso não foram tocados.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const S = {
  pagina: { padding: 24, maxWidth: 1040, margin: "0 auto" },
  titulo: { margin: 0, fontFamily: "'Sora', Inter, sans-serif", fontSize: 26, fontWeight: 800, color: "#0d1321", letterSpacing: "-0.03em" },
  subtitulo: { color: "#64748b", marginTop: 8, marginBottom: 0, maxWidth: 760, lineHeight: 1.5 },
  grade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginTop: 18 },
  numero: { border: "1px solid #e6eaf0", borderRadius: 12, padding: "12px 14px", background: "#fff", display: "flex", flexDirection: "column", gap: 2 },
  numeroDestaque: { background: "#e8eef6", borderColor: "transparent" },
  numeroRot: { fontSize: 11.5, letterSpacing: ".03em", textTransform: "uppercase", color: "#64748b", fontWeight: 700 },
  numeroVal: { fontSize: 21, fontWeight: 800, color: "#0d1321", fontVariantNumeric: "tabular-nums" },
  rodape: { fontSize: 12.5, color: "#64748b", marginTop: 10 },
  caixaAcao: { marginTop: 20, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap", border: "1px solid #e6eaf0", borderRadius: 12, padding: 16, background: "#fff" },
  label: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "#334155" },
  select: { border: "1px solid #cbd5e1", borderRadius: 8, padding: "8px 10px", fontSize: 13 },
  botao: { background: "#2563eb", color: "#fff", border: "none", borderRadius: 8, padding: "10px 18px", fontWeight: 700, cursor: "pointer", fontSize: 14 },
  botaoDesativado: { opacity: 0.6, cursor: "default" },
  aviso: { fontSize: 12.5, color: "#64748b", flex: 1, minWidth: 220 },
  rodando: { marginTop: 12, fontSize: 13, color: "#b45309", fontWeight: 600 },
  erro: { marginTop: 12, fontSize: 13, color: "#b91c1c", fontWeight: 600 },
  resultado: { marginTop: 22 },
  resultadoTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 15, fontWeight: 800, color: "#0d1321" },
  nota: { fontSize: 12.5, color: "#64748b", marginTop: 10, lineHeight: 1.5 },
};
