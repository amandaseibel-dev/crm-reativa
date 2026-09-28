// Aba Carteira: a lista de títulos preventivos, com filtros e o botão de
// atualizar com o Prime.
//
// A tela NUNCA apresenta a lista como conferida quando a última atualização
// completa falhou ou está velha — o aviso vem antes da tabela, não depois.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import { moeda, dataCurta, dataHora } from "../../utils/preventivoFormato";
import { frescorDaAtualizacao } from "../../utils/preventivo";

const FAIXAS = [
  { id: "", rotulo: "Qualquer atraso" },
  { id: "a_vencer", rotulo: "Ainda vai vencer" },
  { id: "0_5", rotulo: "1 a 5 dias" },
  { id: "6_15", rotulo: "6 a 15 dias" },
  { id: "16_31", rotulo: "16 a 31 dias" },
  { id: "acima_31", rotulo: "Acima de 31 (fora da janela)" },
];

// A palavra escolhida importa: o que a API entrega é o VALOR do título
// (netAmount), não um saldo em aberto. Os rótulos dizem exatamente isso.
const ALTERACOES = [
  { id: "", rotulo: "Qualquer alteração" },
  { id: "sem_alteracao", rotulo: "Sem alteração de valor na fonte" },
  { id: "caiu", rotulo: "Valor caiu na fonte" },
  { id: "zerado", rotulo: "Valor zerado na fonte" },
];

const VINCULOS = [
  { id: "", rotulo: "Qualquer vínculo com o Prime" },
  { id: "UNICO", rotulo: "Vínculo único (confere)" },
  { id: "AMBIGUO", rotulo: "Ambíguo (mais de um candidato)" },
  { id: "NAO_ENCONTRADO", rotulo: "Não encontrado no Prime" },
  { id: "PENDENTE", rotulo: "Ainda não consultado" },
];

export function AvisoAtualizacao({ situacao }) {
  const f = frescorDaAtualizacao(situacao);
  const cores = {
    nunca: { fundo: "var(--rv-ambar-fundo)", borda: "var(--rv-ambar-borda)", texto: "var(--rv-ambar-texto)" },
    desatualizado: { fundo: "var(--rv-ambar-fundo)", borda: "var(--rv-ambar-borda)", texto: "var(--rv-ambar-texto)" },
    atual: { fundo: "var(--rv-verde-claro)", borda: "var(--rv-verde-borda)", texto: "var(--rv-verde-escuro)" },
  }[f.nivel];
  const tentativa = situacao?.ultima_tentativa;
  return (
    <div style={{ background: cores.fundo, border: `1px solid ${cores.borda}`, color: cores.texto,
                  borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, marginBottom: 14 }}>
      {f.texto}
      {situacao?.ultima_completa?.concluido_em
        ? ` Última atualização completa: ${dataHora(situacao.ultima_completa.concluido_em)}.`
        : ""}
      {tentativa?.status === "FALHOU"
        ? ` A última tentativa falhou (${tentativa.erros || 0} aluno(s) sem resposta do Prime); os valores mostrados são os anteriores.`
        : ""}
    </div>
  );
}

export default function AbaCarteira({ carteira }) {
  const [titulos, setTitulos] = useState(null);
  const [situacao, setSituacao] = useState(null);
  const [erro, setErro] = useState("");
  const [atualizando, setAtualizando] = useState(false);
  const [filtros, setFiltros] = useState({ status: "", faixa: "", alteracao: "", vinculo: "" });

  // Buscar não mexe em estado: quem aplica é o efeito (ou o botão). Com os
  // filtros mudando rápido, uma resposta atrasada não pode sobrescrever a
  // lista da consulta mais nova.
  const buscar = useCallback(() => Promise.all([
    supabase.rpc("preventivo_titulos", {
      p_carteira_id: carteira.id,
      p_status: filtros.status || null,
      p_faixa_atraso: filtros.faixa || null,
      p_alteracao: filtros.alteracao || null,
    }),
    supabase.rpc("preventivo_sinc_situacao", { p_carteira_id: carteira.id }),
  ]), [carteira.id, filtros]);

  const aplicar = useCallback(([t, s]) => {
    if (t.error) { setErro(t.error.message); setTitulos([]); } else { setErro(""); setTitulos(t.data || []); }
    if (!s.error) setSituacao(s.data);
  }, []);

  const carregar = useCallback(async () => aplicar(await buscar()), [buscar, aplicar]);

  useEffect(() => {
    let vivo = true;
    buscar().then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  // "Atualizar agora": chama a Edge Function até ela dizer que acabou. A trava
  // contra execução simultânea está no banco — dois cliques não viram dois
  // ciclos.
  async function atualizarAgora() {
    setErro(""); setAtualizando(true);
    try {
      let sincId = null;
      for (let volta = 0; volta < 40; volta++) {
        const { data, error } = await supabase.functions.invoke("prev-sincronizar", {
          body: sincId ? { sinc_id: sincId } : { carteira_id: carteira.id, origem: "manual" },
        });
        if (error) throw error;
        sincId = data?.sinc_id;
        if (data?.concluido) break;
      }
    } catch (e) {
      setErro("Não consegui concluir a atualização com o Prime agora. Os valores anteriores continuam válidos. " + (e?.message || ""));
    }
    setAtualizando(false);
    await carregar();
  }

  return (
    <div>
      <AvisoAtualizacao situacao={situacao} />

      <div style={S.barra}>
        <select style={S.select} value={filtros.status}
                onChange={(e) => setFiltros({ ...filtros, status: e.target.value })}>
          <option value="">Na janela e fora dela</option>
          <option value="ATIVO">Só na janela preventiva</option>
          <option value="FORA_DA_JANELA">Só fora da janela (histórico)</option>
        </select>
        <select style={S.select} value={filtros.faixa}
                onChange={(e) => setFiltros({ ...filtros, faixa: e.target.value })}>
          {FAIXAS.map((f) => <option key={f.id} value={f.id}>{f.rotulo}</option>)}
        </select>
        <select style={S.select} value={filtros.alteracao}
                onChange={(e) => setFiltros({ ...filtros, alteracao: e.target.value })}>
          {ALTERACOES.map((m) => <option key={m.id} value={m.id}>{m.rotulo}</option>)}
        </select>
        <select style={S.select} value={filtros.vinculo}
                onChange={(e) => setFiltros({ ...filtros, vinculo: e.target.value })}>
          {VINCULOS.map((m) => <option key={m.id} value={m.id}>{m.rotulo}</option>)}
        </select>
        <button onClick={atualizarAgora} disabled={atualizando} style={S.btnGhost}>
          {atualizando ? "Consultando o Prime…" : "Atualizar agora"}
        </button>
      </div>

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {titulos === null ? <p style={S.muted}>Carregando…</p>
        : titulos.length === 0 ? (
          <div style={{ ...S.card, padding: 22 }}>
            <p style={S.muted}>
              Nenhum título com esses filtros. Se a carteira está vazia, o próximo passo
              é a aba <strong>Importações</strong>.
            </p>
          </div>
        ) : (
          <div style={S.card}>
            <table style={S.tabela}>
              <thead><tr>
                <th style={S.th}>Aluno</th>
                <th style={S.th}>Matrícula</th>
                <th style={S.th}>Título</th>
                <th style={S.th}>Comp.</th>
                <th style={S.th}>Venc. atual</th>
                <th style={S.th}>Venc. origem</th>
                <th style={S.thNum}>Atraso</th>
                <th style={S.thNum}>Saldo informado</th>
                <th style={S.thNum}>Valor na fonte</th>
                <th style={S.th}>Vínculo</th>
                <th style={S.th}>Alteração</th>
                <th style={S.th}>Lote</th>
                <th style={S.th}>Última ação</th>
              </tr></thead>
              <tbody>
                {titulos.map((t) => (
                  <tr key={t.id}>
                    <td style={S.td}>{t.aluno}</td>
                    <td style={S.td}>{t.matricula}</td>
                    <td style={S.td}>{t.documento}</td>
                    <td style={S.td}>{t.competencia || "—"}</td>
                    <td style={S.td}>{dataCurta(t.vencimento)}</td>
                    <td style={S.td}>{dataCurta(t.vencimento_origem)}</td>
                    <td style={S.tdNum}>{t.dias_atraso < 0 ? `em ${-t.dias_atraso}d` : `${t.dias_atraso}d`}</td>
                    <td style={S.tdNum}>{moeda(t.saldo_informado)}</td>
                    <td style={S.tdNum}>
                      {t.valor_fonte === null
                        ? <span style={{ color: "var(--rv-texto-fraco)", fontWeight: 600 }}>—</span>
                        : moeda(t.valor_fonte)}
                    </td>
                    <td style={S.td}><Vinculo t={t} /></td>
                    <td style={S.td}><Alteracao t={t} /></td>
                    <td style={S.td}>{t.lote || "—"}</td>
                    <td style={S.td}>
                      {t.ultima_acao
                        ? `${t.ultima_acao.nome} (${t.ultima_acao.estado === "ENVIO_CONFIRMADO" ? "envio confirmado" : t.ultima_acao.estado.toLowerCase()})`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </div>
  );
}

// O relatório não traz identificador de título, então o vínculo com o Prime é
// resolvido por matrícula + vencimento. Quando há mais de um candidato, fica
// ambíguo — e ambíguo aparece na tela, não é resolvido no escuro.
function Vinculo({ t }) {
  if (t.vinculo === "UNICO") return <Marca cor="verde">confere</Marca>;
  if (t.vinculo === "AMBIGUO") return <Marca cor="ambar">{t.candidatos} candidatos</Marca>;
  if (t.vinculo === "NAO_ENCONTRADO") return <Marca cor="ambar">não achado</Marca>;
  return <Marca cor="cinza">não consultado</Marca>;
}

// "caiu o valor na fonte" NÃO é "pagou". O rótulo diz o que foi medido.
function Alteracao({ t }) {
  if (t.status === "FORA_DA_JANELA") return <Marca cor="cinza">fora da janela</Marca>;
  const m = t.ultima_alteracao;
  if (!m) return <Marca cor="cinza">sem alteração</Marca>;
  if (m.tipo === "VALOR_FONTE_ZEROU") return <Marca cor="verde">valor zerou</Marca>;
  if (m.tipo === "VALOR_FONTE_CAIU") return <Marca cor="azul">valor caiu</Marca>;
  if (m.tipo === "VALOR_FONTE_SUBIU") return <Marca cor="cinza">valor subiu</Marca>;
  if (m.tipo === "AUSENTE_NO_EXTRATO") return <Marca cor="ambar">sumiu do extrato</Marca>;
  return <Marca cor="cinza">{String(m.tipo).toLowerCase().replace(/_/g, " ")}</Marca>;
}

function Marca({ cor, children }) {
  const p = {
    verde: { b: "var(--rv-verde-claro)", c: "var(--rv-verde-escuro)", d: "var(--rv-verde-borda)" },
    azul: { b: "var(--rv-azul-fundo)", c: "var(--rv-azul-texto)", d: "var(--rv-azul-borda)" },
    ambar: { b: "var(--rv-ambar-fundo)", c: "var(--rv-ambar-texto)", d: "var(--rv-ambar-borda)" },
    cinza: { b: "var(--rv-fundo-suave)", c: "var(--rv-texto-suave)", d: "var(--rv-borda)" },
  }[cor];
  return (
    <span style={{ background: p.b, color: p.c, border: `1px solid ${p.d}`, borderRadius: 999,
                   padding: "3px 10px", fontSize: 11.5, fontWeight: 700, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}
