// PREVENTIVO — operação separada da cobrança.
//
// O que esta frente faz: orientar o aluno a pagar a mensalidade no WebAluno
// ANTES de o título virar dívida. Não cobra honorário, não negocia, não cria
// caso, não distribui operador, não mexe em acordo, fila, meta ou resultado da
// cobrança. Por isso não há aqui nenhum controle de acordo, honorário ou link
// de pagamento — e isso é desenho, não falta.
//
// A trava de acesso REAL está no banco (`public.preventivo_e_gestao()`, na
// RLS de toda tabela `prev_` e no começo de toda RPC). O gate de rota em
// App.jsx é conforto: sem ele a tela abriria e voltaria vazia.
//
// A aba escolhida mora na URL (`?aba=`), como no hub do Financeiro — assim o
// link que a gestão manda para si mesma abre onde ela parou.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import AbaCarteira from "../components/preventivo/AbaCarteira";
import AbaImportacoes from "../components/preventivo/AbaImportacoes";
import AbaAcoes from "../components/preventivo/AbaAcoes";
import AbaResultados from "../components/preventivo/AbaResultados";
import { moeda, dataCurta } from "../utils/preventivoFormato";

const ABAS = [
  { id: "carteira", rotulo: "Carteira" },
  { id: "importacoes", rotulo: "Importações" },
  { id: "acoes", rotulo: "Ações" },
  { id: "resultados", rotulo: "Resultados" },
];

export default function Preventivo() {
  const [params, setParams] = useSearchParams();
  const aba = ABAS.some((a) => a.id === params.get("aba")) ? params.get("aba") : "carteira";
  const carteiraDaUrl = params.get("carteira") || "";

  const [carteiras, setCarteiras] = useState(null);
  const [erro, setErro] = useState("");
  const [criando, setCriando] = useState(false);
  const [nova, setNova] = useState({ nome: "", venc_de: "", venc_ate: "" });

  // A busca não mexe em estado; quem aplica é o efeito (ou o botão). Assim uma
  // resposta que chega atrasada, depois de a gestão já ter trocado de
  // carteira, não sobrescreve a tela.
  const buscar = useCallback(() => supabase.rpc("preventivo_carteiras"), []);
  const aplicar = useCallback(({ data, error }) => {
    if (error) { setErro(error.message); setCarteiras([]); return; }
    setErro(""); setCarteiras(data || []);
  }, []);
  const carregar = useCallback(async () => aplicar(await buscar()), [buscar, aplicar]);

  useEffect(() => {
    let vivo = true;
    buscar().then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  const carteira = useMemo(() => {
    if (!carteiras?.length) return null;
    return carteiras.find((c) => c.id === carteiraDaUrl) || carteiras[0];
  }, [carteiras, carteiraDaUrl]);

  const irPara = (novaAba, novaCarteira) => {
    const p = new URLSearchParams(params);
    p.set("aba", novaAba || aba);
    if (novaCarteira) p.set("carteira", novaCarteira);
    else if (carteira) p.set("carteira", carteira.id);
    setParams(p, { replace: true });
  };

  async function criarCarteira(e) {
    e.preventDefault();
    setErro("");
    if (!nova.nome.trim() || !nova.venc_de || !nova.venc_ate) {
      setErro("Dê um nome à carteira e escolha a janela de vencimento.");
      return;
    }
    setCriando(true);
    const { data, error } = await supabase.rpc("preventivo_carteira_criar", {
      p_nome: nova.nome.trim(), p_descricao: null,
      p_venc_de: nova.venc_de, p_venc_ate: nova.venc_ate,
    });
    setCriando(false);
    if (error) { setErro(error.message); return; }
    setNova({ nome: "", venc_de: "", venc_ate: "" });
    await carregar();
    irPara("importacoes", data);
  }

  if (carteiras === null) {
    return <div style={S.wrap}><p style={S.muted}>Carregando o Preventivo…</p></div>;
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Preventivo</h1>
          <p style={S.sub}>
            Mensalidade antes de virar dívida. Orientação de pagamento pelo WebAluno,
            sem honorário e sem negociação. Nada aqui altera a cobrança.
          </p>
        </div>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {/* Carteira vazia: o próximo passo é criar a primeira, e a tela diz isso. */}
      {carteiras.length === 0 ? (
        <div style={{ ...S.card, padding: 22, maxWidth: 620 }}>
          <h2 style={{ ...S.cardNome, fontSize: 17, margin: 0 }}>Comece pela primeira carteira</h2>
          <p style={{ ...S.muted, marginTop: 8 }}>
            Uma carteira é um recorte de títulos por janela de vencimento — você escolhe
            o período, sem antecedência fixa. Depois de criar, a aba <strong>Importações</strong>
            recebe o relatório do Prime.
          </p>
          <FormularioNova nova={nova} setNova={setNova} criando={criando} onSubmit={criarCarteira} />
        </div>
      ) : (
        <>
          <div style={{ ...S.barra, alignItems: "center" }}>
            <label style={{ ...S.muted, fontWeight: 700 }}>Carteira</label>
            <select
              style={S.select}
              value={carteira?.id || ""}
              onChange={(e) => irPara(aba, e.target.value)}
            >
              {carteiras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.nome} — venc. {dataCurta(c.venc_de)} a {dataCurta(c.venc_ate)}
                </option>
              ))}
            </select>
            <div style={S.contadores}>
              <span style={S.contadorAlunos}>{carteira?.alunos || 0} alunos</span>
              <span style={S.contadorAcordos}>{carteira?.titulos || 0} títulos</span>
              <span style={S.contadorValor}>{moeda(carteira?.valor_inicial)} na entrada</span>
            </div>
          </div>

          <div style={{ display: "flex", gap: 6, borderBottom: "1px solid var(--rv-borda)", marginBottom: 18 }}>
            {ABAS.map((a) => (
              <button
                key={a.id}
                onClick={() => irPara(a.id)}
                style={{
                  background: "transparent", border: "none", cursor: "pointer",
                  padding: "10px 16px", fontWeight: 800, fontSize: 13.5,
                  color: a.id === aba ? "var(--rv-tinta)" : "var(--rv-texto-suave)",
                  borderBottom: a.id === aba ? "2px solid var(--rv-azul)" : "2px solid transparent",
                }}
              >
                {a.rotulo}
              </button>
            ))}
          </div>

          {carteira ? (
            <>
              {aba === "carteira" && <AbaCarteira carteira={carteira} onIr={irPara} />}
              {aba === "importacoes" && <AbaImportacoes carteira={carteira} aoImportar={carregar} />}
              {aba === "acoes" && <AbaAcoes carteira={carteira} />}
              {aba === "resultados" && <AbaResultados carteira={carteira} />}
            </>
          ) : null}

          <details style={{ marginTop: 28 }}>
            <summary style={{ ...S.muted, cursor: "pointer", fontWeight: 700 }}>Criar outra carteira</summary>
            <div style={{ ...S.card, padding: 18, maxWidth: 620, marginTop: 10 }}>
              <FormularioNova nova={nova} setNova={setNova} criando={criando} onSubmit={criarCarteira} />
            </div>
          </details>
        </>
      )}
    </div>
  );
}

function FormularioNova({ nova, setNova, criando, onSubmit }) {
  return (
    <form onSubmit={onSubmit} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14 }}>
      <div>
        <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Nome da carteira</label>
        <input style={S.input} value={nova.nome} placeholder="Ex.: Vencimentos de outubro"
               onChange={(e) => setNova({ ...nova, nome: e.target.value })} />
      </div>
      <div>
        <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Vencimento de</label>
        <input type="date" style={{ ...S.input, minWidth: 0 }} value={nova.venc_de}
               onChange={(e) => setNova({ ...nova, venc_de: e.target.value })} />
      </div>
      <div>
        <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Vencimento até</label>
        <input type="date" style={{ ...S.input, minWidth: 0 }} value={nova.venc_ate}
               onChange={(e) => setNova({ ...nova, venc_ate: e.target.value })} />
      </div>
      <button type="submit" disabled={criando} style={S.btnGhost}>
        {criando ? "Criando…" : "Criar carteira"}
      </button>
    </form>
  );
}
