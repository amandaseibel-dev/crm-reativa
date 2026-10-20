import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S as A } from "../ui/estilosFila";
import {
  FORMAS,
  PERMITIDOS_LEGIVEL,
  CARRIER_DO_ACORDO,
  agregarResposta,
  caminhoPermitido,
  diferencasDeAgregado,
  formaPorChave,
  montarCaminho,
  motivoDaRecusa,
  osQuatroCaminhos,
  respostasIdenticas,
} from "../utils/primeSonda";

// PAINEL DE DIAGNÓSTICO DA INTEGRAÇÃO PRIME
// =============================================================================
//
// POR QUE ESTA TELA EXISTE. A Edge Function `prime-sonda` já estava em
// produção, versionada, com allowlist de caminho e portão de gestão — mas
// NENHUMA tela a chamava. Para rodar uma sondagem, alguém tinha de apresentar
// um JWT válido ao gateway, e o único jeito de conseguir um era ir buscar o da
// sessão no armazenamento do navegador e colar em algum lugar. A gestão proibiu
// isso, com razão: segredo que passa pela mão de alguém vira segredo copiado.
//
// A tela resolve pela via mais simples que existe: `supabase.functions.invoke`
// anexa a sessão de quem está logado SOZINHO. Esta entrega não lê, não copia,
// não guarda e não monta credencial nenhuma — não há uma linha aqui que toque
// no armazenamento do navegador ou em header de autorização. É o ponto central
// do PR, não um detalhe de implementação.
//
// SÓ LÊ. A `prime-sonda` faz `GET` e nada mais (está escrito no código dela), e
// esta tela não tem nenhum caminho de escrita: as duas únicas chamadas que
// existem aqui são `usuario_e_gestao` (leitura) e a invocação da sonda.
// `DiagnosticoPrime.test.jsx` prende isso lendo o próprio arquivo.
//
// ACESSO. Quem decide é o banco, pela MESMA função que o portão do servidor usa
// (`usuario_e_gestao`) — padrão que Situação Acadêmica, Saúde Completa da
// Carteira, Honorários a Entrar e Acordos Duplicados já seguem. Não há lista de
// e-mail nova aqui. E a restrição no front é só para não oferecer botão que
// terminaria em 401/403: o portão de verdade é o `decidirAcesso` de
// supabase/functions/prime-sonda/portao.ts, que valida a sessão no servidor e
// recusa por conta própria quem não for gestão.
//
// O QUE A TELA MOSTRA, E O QUE ELA NÃO MOSTRA. Ver o cabeçalho de
// src/utils/primeSonda.js: a `forma` que a sonda devolve sem `cru` carrega
// VALOR de escalar curto (nome, CPF), então ela nunca é exibida. O padrão é
// contagem e nome de campo. Conteúdo identificável só aparece com o botão
// ligado de propósito, com aviso.
//
// A PERGUNTA DOS QUATRO TESTES. `docs/integracoes/prime-api.md` já documenta,
// medido, que `carrierId` é ignorado no extrato e que `agreements` sempre voltou
// vazio. O botão dos quatro testes existe para a gestão RECONFERIR isso com a
// própria sessão, no dia de hoje. Divergência aqui não é curiosidade: é achado
// que obriga atualizar `docs/integracoes/` na mesma alteração (regra do README).

const MATRICULA_PADRAO = ""; // nunca pré-preenchida: matrícula é dado de pessoa

function Linha({ rotulo, valor, destaque }) {
  return (
    <div style={E.linha}>
      <span style={E.rotulo}>{rotulo}</span>
      <span style={destaque ? E.valorDestaque : E.valor}>{valor}</span>
    </div>
  );
}

// O agregado de UMA resposta. Nada aqui imprime valor de campo de item: só
// contagem, nome de campo e o que a sonda informa sobre a chamada.
function Agregado({ ag }) {
  if (!ag) return null;
  return (
    <>
      <Linha rotulo="status da Prime" valor={ag.statusPrime ?? "—"} destaque />
      <Linha rotulo="tipo" valor={ag.tipo || "—"} />
      <Linha rotulo="tamanho" valor={ag.tamanho === null ? "—" : `${ag.tamanho} bytes`} />
      <Linha rotulo="itens" valor={ag.itens === null ? "—" : ag.itens} destaque />
      {ag.totalItens !== null && <Linha rotulo="totalItems" valor={ag.totalItens} />}
      <Linha
        rotulo={`isAgreementInstallment = true`}
        valor={ag.itens === null ? "—" : ag.parcelaDeAcordo}
        destaque
      />
      <div style={E.bloco}>
        <span style={E.rotulo}>contagem por carrier.id</span>
        {ag.porCarrier.length === 0 ? (
          <span style={E.valor}>— nenhum item com portador</span>
        ) : (
          <ul style={E.lista}>
            {ag.porCarrier.map((c) => (
              <li key={c.id} style={String(c.id) === String(CARRIER_DO_ACORDO) ? E.itemDestaque : E.item}>
                <b>{c.id}</b>
                {c.nome ? ` · ${c.nome}` : ""} — {c.n}
              </li>
            ))}
          </ul>
        )}
      </div>
      {ag.campos.length > 0 && (
        <div style={E.bloco}>
          <span style={E.rotulo}>campos do primeiro item ({ag.campos.length})</span>
          <code style={E.codigo}>{ag.campos.join(", ")}</code>
        </div>
      )}
      {ag.chavesDeTopo.length > 0 && (
        <div style={E.bloco}>
          <span style={E.rotulo}>chaves de topo</span>
          <code style={E.codigo}>{ag.chavesDeTopo.join(", ")}</code>
        </div>
      )}
      {ag.blocos.length > 0 && (
        <div style={E.bloco}>
          <span style={E.rotulo}>por bloco</span>
          <ul style={E.lista}>
            {ag.blocos.map((b) => (
              <li key={b.chave} style={E.item}>
                <b>{b.chave}</b>
                {b.itens === null
                  ? ` — objeto${b.campos.length ? ` · ${b.campos.length} campos` : ""}`
                  : ` — ${b.itens} ${b.itens === 1 ? "item" : "itens"}${
                      b.parcelaDeAcordo ? ` · ${b.parcelaDeAcordo} com isAgreementInstallment=true` : ""
                    }`}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function Cartao({ r, mostrarIdentificavel }) {
  return (
    <div style={E.cartao}>
      <div style={E.cartaoTopo}>
        <span style={E.cartaoTitulo}>{r.rotulo}</span>
        <code style={E.caminho}>{r.caminho}</code>
      </div>
      {r.estado === "ocupado" && <p style={E.mudo}>Consultando…</p>}
      {r.estado === "recusado" && (
        <p style={E.recusa}>
          Não enviado: {r.erro}. A conferência da tela é conveniência — o portão
          de verdade é o do servidor.
        </p>
      )}
      {r.estado === "erro" && <p style={E.falha}>{r.erro}</p>}
      {/* Dois status, nunca achatados num só: o da Edge Function (se ela
          respondeu) e o que a ULBRA devolveu para o GET. Um 200 da sonda com
          404 da Prime é um caso real e tem de ser legível. `invoke` só devolve
          dados quando o gateway respondeu 2xx -- não há como ser outro. */}
      {r.estado === "ok" && <Linha rotulo="resposta da sonda" valor="HTTP 2xx (respondeu)" />}
      {r.estado === "ok" && <Agregado ag={r.agregado} />}
      {r.estado === "ok" && mostrarIdentificavel && (
        <div style={E.bloco}>
          <span style={E.rotuloAviso}>conteúdo da resposta — contém dado pessoal</span>
          <pre style={E.cru}>{JSON.stringify(r.corpo, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}

export default function DiagnosticoPrime() {
  // null = ainda não se sabe. Erro ao perguntar fecha a porta: na dúvida, não
  // oferecer um botão que terminaria em 403.
  const [ehGestao, setEhGestao] = useState(null);
  const [formaChave, setFormaChave] = useState("financial_statement");
  const [matricula, setMatricula] = useState(MATRICULA_PADRAO);
  const [query, setQuery] = useState("");
  const [mostrarIdentificavel, setMostrarIdentificavel] = useState(false);
  const [resultados, setResultados] = useState([]);
  const [ocupado, setOcupado] = useState(false);
  const [avisoQuatro, setAvisoQuatro] = useState("");

  useEffect(() => {
    let vivo = true;
    supabase
      .rpc("usuario_e_gestao")
      .then(({ data, error }) => { if (vivo) setEhGestao(!error && data === true); })
      .catch(() => { if (vivo) setEhGestao(false); });
    return () => { vivo = false; };
  }, []);

  const forma = formaPorChave(formaChave);
  const caminhoAtual = montarCaminho({ forma: formaChave, matricula, query });
  const recusaAtual = motivoDaRecusa({ forma: formaChave, matricula, query });

  // UMA chamada à sonda. `cru: true` NÃO é descuido: contar por portador e
  // comparar duas respostas exige o conteúdo. O conteúdo fica na memória desta
  // tela e só é desenhado se alguém ligar o botão do aviso — ver o cabeçalho de
  // src/utils/primeSonda.js.
  const consultar = useCallback(async (caminho, rotulo, chave) => {
    if (!caminhoPermitido(caminho)) {
      return { chave, rotulo, caminho, estado: "recusado", erro: `caminho fora da lista permitida (${caminho})` };
    }
    try {
      // A SESSÃO VIAJA SOZINHA. O cliente de ../services/supabase anexa a
      // sessão de quem está logado; nada é lido do navegador nem montado aqui.
      const { data, error } = await supabase.functions.invoke("prime-sonda", {
        body: { caminho, cru: true },
      });
      if (error) {
        const st = error?.context?.status;
        return {
          chave, rotulo, caminho, estado: "erro",
          erro: `A sonda recusou ou falhou${st ? ` (HTTP ${st})` : ""}: ${error?.message || "erro sem mensagem"}`,
        };
      }
      if (data?.erro) {
        return { chave, rotulo, caminho, estado: "erro", erro: `A sonda respondeu ${data.erro}` };
      }
      return { chave, rotulo, caminho, estado: "ok", agregado: agregarResposta(data), corpo: data?.cru ?? null };
    } catch (e) {
      return { chave, rotulo, caminho, estado: "erro", erro: `Não foi possível consultar: ${e?.message || String(e)}` };
    }
  }, []);

  async function consultarUm() {
    setAvisoQuatro("");
    if (recusaAtual) {
      setResultados([{ chave: "um", rotulo: forma?.rotulo || "caminho", caminho: caminhoAtual, estado: "recusado", erro: recusaAtual }]);
      return;
    }
    setOcupado(true);
    setResultados([{ chave: "um", rotulo: forma?.rotulo || "caminho", caminho: caminhoAtual, estado: "ocupado" }]);
    const r = await consultar(caminhoAtual, forma?.rotulo || "caminho", "um");
    setResultados([r]);
    setOcupado(false);
  }

  // OS QUATRO TESTES, EM SEQUÊNCIA. Em sequência de propósito: são leituras na
  // API da ULBRA com a mesma chave, e disparar as quatro juntas só serviria
  // para a ULBRA ver um pico. Cada resposta aparece assim que chega.
  async function rodarOsQuatro() {
    const m = String(matricula || "").trim();
    if (!m) { setAvisoQuatro("Informe a matrícula (registration) antes de rodar os quatro testes."); return; }
    setAvisoQuatro("");
    setOcupado(true);
    const planos = osQuatroCaminhos(m);
    setResultados(planos.map((p) => ({ ...p, estado: "ocupado" })));
    const feitos = [];
    for (const p of planos) {
      const r = await consultar(p.caminho, p.rotulo, p.chave);
      feitos.push(r);
      // Mostra o que já voltou e mantém os próximos como "consultando".
      setResultados([...feitos, ...planos.slice(feitos.length).map((x) => ({ ...x, estado: "ocupado" }))]);
    }
    setOcupado(false);
  }

  // A COMPARAÇÃO É O OBJETIVO DA TELA. `null` quando falta resposta de um dos
  // dois lados: duas falhas não são duas respostas iguais.
  const comparacao = useMemo(() => {
    const t1 = resultados.find((r) => r.chave === "t1");
    const t2 = resultados.find((r) => r.chave === "t2");
    if (!t1 || !t2) return null;
    if (t1.estado !== "ok" || t2.estado !== "ok") {
      return { sabe: false, texto: "não se sabe — uma das duas consultas não respondeu" };
    }
    const iguais = respostasIdenticas(t1.corpo, t2.corpo);
    return {
      sabe: iguais !== null,
      iguais,
      diferencas: iguais === false ? diferencasDeAgregado(t1.agregado, t2.agregado) : [],
      texto: iguais === null ? "não se sabe" : iguais ? "sim" : "não",
    };
  }, [resultados]);

  if (ehGestao === null) {
    return (
      <div style={A.wrap}>
        <h1 style={A.titulo}>Diagnóstico da integração Prime</h1>
        <p style={A.muted}>Verificando permissão…</p>
      </div>
    );
  }

  if (ehGestao === false) {
    return (
      <div style={A.wrap}>
        <h1 style={A.titulo}>Diagnóstico da integração Prime</h1>
        <p style={A.muted}>
          Esta tela é <b>restrita à gestão</b>. Quem decide é a mesma função do
          banco que o portão da Edge Function usa, então não há botão aqui que
          funcionaria para outro perfil.
        </p>
      </div>
    );
  }

  return (
    <div style={A.wrap}>
      <div style={A.topo}>
        <div>
          <h1 style={A.titulo}>Diagnóstico da integração Prime</h1>
          <p style={A.sub}>
            Leitura pela Edge Function <code>prime-sonda</code>, com a sua
            própria sessão. Só <code>GET</code>: nada é gravado, nem no CRM nem
            na ULBRA.
          </p>
        </div>
      </div>

      <div style={E.nota}>
        <b>O resultado vem agregado.</b> A tela mostra contagens e nomes de
        campo — nunca o valor dos campos, porque a resposta da ULBRA traz nome e
        CPF. O conteúdo chega ao navegador (é a sua sessão consultando), e o que
        esta tela garante é que ele não aparece na página sem alguém pedir.
        <br />
        <b>O que já está documentado</b> em <code>docs/integracoes/prime-api.md</code>:
        no extrato, <code>carrierId</code> foi medido como <i>ignorado</i>
        {" "}(resposta idêntica com e sem ele); <code>agreements</code> voltou
        {" "}<code>totalItems: 0</code> em todos os testes; e o portador{" "}
        {CARRIER_DO_ACORDO} nunca apareceu numa linha de extrato. Estes quatro
        testes reconferem isso hoje — se divergir, a regra do README manda
        atualizar aquele diretório na mesma alteração.
      </div>

      <div style={E.caixa}>
        <div style={A.barra}>
          <label style={E.campo}>
            <span style={E.rotulo}>forma do caminho</span>
            <select
              aria-label="forma do caminho"
              value={formaChave}
              onChange={(e) => setFormaChave(e.target.value)}
              style={A.select}
            >
              {FORMAS.map((f) => (
                <option key={f.chave} value={f.chave}>{f.rotulo}</option>
              ))}
            </select>
          </label>
          <label style={E.campo}>
            <span style={E.rotulo}>matrícula (registration)</span>
            <input
              aria-label="matrícula"
              value={matricula}
              onChange={(e) => setMatricula(e.target.value)}
              disabled={!forma?.exigeMatricula}
              placeholder={forma?.exigeMatricula ? "ex.: 232005643" : "não se aplica a esta forma"}
              style={A.input}
            />
          </label>
          <label style={E.campo}>
            <span style={E.rotulo}>query string (opcional)</span>
            <input
              aria-label="query string"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={forma?.aceitaQuery ? "ex.: carrierId=166&take=200" : "esta forma não aceita query"}
              style={A.input}
            />
          </label>
        </div>

        <p style={E.previa}>
          caminho que sairia: <code style={E.codigo}>{caminhoAtual || "—"}</code>
          {forma?.legenda ? <span style={E.legenda}> · {forma.legenda}</span> : null}
        </p>
        {recusaAtual && <p style={E.recusa}>{recusaAtual}</p>}

        <div style={E.acoes}>
          <button type="button" onClick={consultarUm} disabled={ocupado} style={{ ...A.btnGhost, ...(ocupado ? A.btnBusy : null) }}>
            {ocupado ? "Consultando…" : "Consultar este caminho"}
          </button>
          <button type="button" onClick={rodarOsQuatro} disabled={ocupado} style={{ ...A.btnGhost, ...(ocupado ? A.btnBusy : null) }}>
            Rodar os quatro testes
          </button>
          <label style={E.toggle}>
            <input
              type="checkbox"
              checked={mostrarIdentificavel}
              onChange={(e) => setMostrarIdentificavel(e.target.checked)}
            />
            ver conteúdo identificável
          </label>
        </div>
        {avisoQuatro && <p style={E.recusa}>{avisoQuatro}</p>}
        {mostrarIdentificavel && (
          <p style={E.alerta}>
            <b>Atenção:</b> com esta opção ligada a tela exibe o conteúdo da
            resposta, que inclui <b>dado pessoal</b> (nome, CPF, valores do
            aluno). Desligue antes de compartilhar a tela ou tirar print.
          </p>
        )}
        <p style={E.permitidos}>
          Caminhos permitidos pelo portão do servidor: {PERMITIDOS_LEGIVEL.join(" · ")}
        </p>
      </div>

      {comparacao && (
        <div style={comparacao.iguais === false ? E.vereditoDivergente : E.veredito}>
          <b>Resposta 1 e 2 são idênticas: {comparacao.texto}</b>
          {comparacao.iguais === true && (
            <span style={E.vereditoSub}>
              {" "}— o extrato não é filtrado por escopo de portador nesta
              chamada, como <code>prime-api.md</code> já registrava.
            </span>
          )}
          {comparacao.iguais === false && (
            <span style={E.vereditoSub}>
              {" "}— o extrato RESPONDE ao <code>carrierId</code>. Isto contraria
              o que está documentado e precisa entrar em{" "}
              <code>docs/integracoes/</code>. Diferenças:{" "}
              {comparacao.diferencas.length ? comparacao.diferencas.join("; ") : "mesmas contagens, conteúdo diferente"}.
            </span>
          )}
        </div>
      )}

      {resultados.length > 0 && (
        <div style={E.grade}>
          {resultados.map((r) => (
            <Cartao key={r.chave} r={r} mostrarIdentificavel={mostrarIdentificavel} />
          ))}
        </div>
      )}
    </div>
  );
}

const E = {
  nota: {
    margin: "0 0 14px", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, lineHeight: 1.55,
    background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-borda)", color: "var(--rv-texto-forte)",
  },
  caixa: {
    padding: "14px 16px", borderRadius: 12, marginBottom: 16,
    background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)",
  },
  campo: { display: "flex", flexDirection: "column", gap: 4 },
  rotulo: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-texto-fraco)" },
  rotuloAviso: { fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--rv-vermelho-texto)" },
  valor: { fontSize: 13, color: "var(--rv-texto-forte)" },
  valorDestaque: { fontSize: 13, fontWeight: 800, color: "var(--rv-tinta)" },
  previa: { margin: "8px 0 0", fontSize: 12.5, color: "var(--rv-texto)" },
  legenda: { color: "var(--rv-texto-fraco)" },
  codigo: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12, color: "var(--rv-tinta)", wordBreak: "break-all" },
  acoes: { display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", marginTop: 12 },
  toggle: { display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, fontWeight: 600, color: "var(--rv-texto-forte)", cursor: "pointer" },
  alerta: {
    margin: "10px 0 0", padding: "8px 12px", borderRadius: 8, fontSize: 12.5,
    background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)", border: "1px solid var(--rv-vermelho-borda)",
  },
  recusa: {
    margin: "8px 0 0", padding: "8px 12px", borderRadius: 8, fontSize: 12.5,
    background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", border: "1px solid var(--rv-ambar-borda)",
  },
  permitidos: { margin: "12px 0 0", paddingTop: 8, borderTop: "1px dashed var(--rv-borda)", fontSize: 11.5, color: "var(--rv-texto-fraco)" },
  veredito: {
    padding: "12px 16px", borderRadius: 10, marginBottom: 14, fontSize: 13.5, lineHeight: 1.5,
    background: "var(--rv-verde-ok-fundo)", color: "var(--rv-verde-ok-texto)", border: "1px solid var(--rv-verde-ok-borda)",
  },
  vereditoDivergente: {
    padding: "12px 16px", borderRadius: 10, marginBottom: 14, fontSize: 13.5, lineHeight: 1.5,
    background: "var(--rv-ambar-fundo)", color: "var(--rv-ambar-texto)", border: "1px solid var(--rv-ambar-borda)",
  },
  vereditoSub: { fontWeight: 500 },
  grade: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 14, alignItems: "start" },
  cartao: {
    padding: "12px 14px", borderRadius: 12, display: "flex", flexDirection: "column", gap: 6,
    background: "var(--rv-superficie)", border: "1px solid var(--rv-borda)",
  },
  cartaoTopo: { display: "flex", flexDirection: "column", gap: 4, paddingBottom: 8, borderBottom: "1px solid var(--rv-borda-suave)" },
  cartaoTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 14, fontWeight: 800, color: "var(--rv-tinta)" },
  caminho: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 11.5, color: "var(--rv-texto-fraco)", wordBreak: "break-all" },
  linha: { display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" },
  bloco: { display: "flex", flexDirection: "column", gap: 4, marginTop: 4 },
  lista: { margin: 0, paddingLeft: 18, fontSize: 12.5, color: "var(--rv-texto-forte)" },
  item: { marginBottom: 2 },
  itemDestaque: { marginBottom: 2, fontWeight: 800, color: "var(--rv-roxo-texto)" },
  cru: {
    margin: 0, padding: "8px 10px", borderRadius: 8, maxHeight: 320, overflow: "auto",
    fontSize: 11, lineHeight: 1.45, background: "var(--rv-fundo-suave)", border: "1px solid var(--rv-vermelho-borda)",
    color: "var(--rv-tinta)", whiteSpace: "pre-wrap", wordBreak: "break-all",
  },
  mudo: { margin: 0, fontSize: 12.5, color: "var(--rv-texto-fraco)" },
  falha: {
    margin: 0, padding: "8px 12px", borderRadius: 8, fontSize: 12.5,
    background: "var(--rv-vermelho-fundo)", color: "var(--rv-vermelho-texto)", border: "1px solid var(--rv-vermelho-borda)",
  },
};
