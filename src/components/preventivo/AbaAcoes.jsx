// Aba Ações do Preventivo.
//
// Fluxo: filtrar público → escolher canal → revisar elegibilidade → prévia →
// exportar → registrar a execução.
//
// EXPORTAR NÃO É ENVIAR. Esta tela não manda mensagem nenhuma: o envio é do CRM
// de mensageria. Por isso os quatro estados existem separados, e "envio
// confirmado" é uma marcação humana, feita depois que a mensageria enviou de
// verdade. Entrega e leitura não aparecem aqui porque não temos retorno real da
// mensageria — inventar status de entrega seria pior do que não ter.
import { useCallback, useEffect, useState } from "react";
import { supabase } from "../../services/supabase";
import { S } from "../../ui/estilosFila";
import { moeda, dataHora } from "../../utils/preventivoFormato";
import { AvisoAtualizacao } from "./AbaCarteira";
import { csv, COLUNAS_WHATSAPP, COLUNAS_EMAIL, COLUNAS_SEPARADOS } from "../../utils/preventivo";

const MOTIVOS = {
  FORA_DA_JANELA_PREVENTIVA: "fora da janela de 31 dias",
  VALOR_NA_FONTE_ZERADO: "o valor do título já está zerado na fonte",
  SITUACAO_CANCELADA_NA_ORIGEM: "situação cancelada na origem",
  SEM_CELULAR_VALIDO: "sem celular válido (fixo ou número incompleto não entram)",
  CELULAR_AMBIGUO_NO_ARQUIVO: "o arquivo traz mais de um celular diferente — não se escolhe um",
  SEM_EMAIL_VALIDO: "sem e-mail válido",
  EMAIL_MULTIPLO_NO_ARQUIVO: "o arquivo traz mais de um e-mail — não se escolhe um sozinho",
  CONTATO_COMPARTILHADO_COM_OUTRO_ALUNO: "mesmo contato aparece para outro aluno",
  OUTRO_TITULO_DO_MESMO_ALUNO_JA_NO_PUBLICO: "o aluno já está no público por outro título",
};

const ROTULO_VINCULO = {
  UNICO: "conferido no Prime",
  AMBIGUO: "vínculo ambíguo no Prime",
  NAO_ENCONTRADO: "não encontrado no Prime",
  PENDENTE: "ainda não consultado no Prime",
};

const ESTADOS = {
  PREPARADA: "Preparada",
  EXPORTADA: "Exportada",
  ENVIO_CONFIRMADO: "Envio confirmado",
  CANCELADA: "Cancelada",
};

function baixar(nome, conteudo) {
  const url = URL.createObjectURL(new Blob(["﻿" + conteudo], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = nome; a.click();
  URL.revokeObjectURL(url);
}

export default function AbaAcoes({ carteira }) {
  const [acoes, setAcoes] = useState(null);
  const [situacao, setSituacao] = useState(null);
  const [erro, setErro] = useState("");
  const [nova, setNova] = useState({ nome: "", canal: "WHATSAPP", venc_de: "", venc_ate: "", usarPrimeiroEmail: false });
  const [ocupado, setOcupado] = useState("");
  const [aberta, setAberta] = useState(null);

  const buscar = useCallback(() => Promise.all([
    supabase.rpc("preventivo_acoes", { p_carteira_id: carteira.id }),
    supabase.rpc("preventivo_sinc_situacao", { p_carteira_id: carteira.id }),
  ]), [carteira.id]);

  const aplicar = useCallback(([a, s]) => {
    if (a.error) { setErro(a.error.message); setAcoes([]); } else { setErro(""); setAcoes(a.data || []); }
    if (!s.error) setSituacao(s.data);
  }, []);

  const carregar = useCallback(async () => aplicar(await buscar()), [buscar, aplicar]);

  useEffect(() => {
    let vivo = true;
    buscar().then((r) => { if (vivo) aplicar(r); });
    return () => { vivo = false; };
  }, [buscar, aplicar]);

  async function preparar(e) {
    e.preventDefault();
    if (!nova.nome.trim()) { setErro("Dê um nome à ação."); return; }
    setOcupado("preparar"); setErro("");
    const filtros = {};
    if (nova.venc_de) filtros.venc_de = nova.venc_de;
    if (nova.venc_ate) filtros.venc_ate = nova.venc_ate;
    // A escolha fica registrada na própria ação — não é um padrão escondido.
    if (nova.canal === "EMAIL" && nova.usarPrimeiroEmail) filtros.usar_primeiro_email = true;
    const { data, error } = await supabase.rpc("preventivo_acao_preparar", {
      p_carteira_id: carteira.id, p_nome: nova.nome.trim(), p_canal: nova.canal, p_filtros: filtros,
    });
    setOcupado("");
    if (error) { setErro(error.message); return; }
    setNova({ ...nova, nome: "" });
    await carregar();
    setAberta(data.id);
  }

  async function marcar(id, estado) {
    setOcupado(id + estado); setErro("");
    const { error } = await supabase.rpc("preventivo_acao_marcar", { p_acao_id: id, p_estado: estado });
    setOcupado("");
    if (error) { setErro(error.message); return; }
    await carregar();
  }

  async function exportarAcao(acao) {
    setErro("");
    const [dentro, fora] = await Promise.all([
      supabase.rpc("preventivo_acao_publico", { p_acao_id: acao.id, p_incluidos: true }),
      supabase.rpc("preventivo_acao_publico", { p_acao_id: acao.id, p_incluidos: false }),
    ]);
    if (dentro.error) { setErro(dentro.error.message); return; }
    const base = acao.nome.replace(/[^\w-]+/g, "-").toLowerCase();
    const colunas = acao.canal === "WHATSAPP" ? COLUNAS_WHATSAPP : COLUNAS_EMAIL;
    baixar(`preventivo-${base}-publico.csv`, csv(dentro.data || [], colunas));
    if ((fora.data || []).length) {
      baixar(`preventivo-${base}-separados.csv`, csv(fora.data, COLUNAS_SEPARADOS));
    }
    if (acao.estado === "PREPARADA") await marcar(acao.id, "EXPORTADA");
  }

  return (
    <div>
      <AvisoAtualizacao situacao={situacao} />
      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      <div style={{ ...S.card, padding: 20 }}>
        <h2 style={{ ...S.cardNome, fontSize: 16, margin: 0 }}>Montar um público</h2>
        <p style={{ ...S.muted, marginTop: 6, maxWidth: 820 }}>
          O público sai da carteira que você importou — nada é acrescentado de fora dela.
          Ficam de fora, com o motivo ao lado: título fora da janela de 31 dias, valor já
          zerado na fonte, situação cancelada, contato inválido, contato ambíguo no arquivo
          e contato repetido entre alunos diferentes. Vínculo pendente com o Prime{" "}
          <strong>não</strong> exclui ninguém — mas aparece no resumo, para a lista nunca
          passar por conferida.
        </p>
        <form onSubmit={preparar} style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 12 }}>
          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Nome da ação</label>
            <input style={S.input} value={nova.nome} placeholder="Ex.: Lembrete D-3 outubro"
                   onChange={(e) => setNova({ ...nova, nome: e.target.value })} />
          </div>
          <div>
            <label style={{ ...S.muted, display: "block", fontSize: 12, fontWeight: 700 }}>Canal</label>
            <select style={S.select} value={nova.canal} onChange={(e) => setNova({ ...nova, canal: e.target.value })}>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="EMAIL">E-mail</option>
            </select>
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
          {nova.canal === "EMAIL" && (
            <label style={{ ...S.muted, display: "flex", alignItems: "center", gap: 6, fontSize: 12.5 }}>
              <input type="checkbox" checked={nova.usarPrimeiroEmail}
                     onChange={(e) => setNova({ ...nova, usarPrimeiroEmail: e.target.checked })} />
              usar o primeiro e-mail quando a linha trouxer mais de um
            </label>
          )}
          <button type="submit" disabled={ocupado === "preparar"} style={S.btnGhost}>
            {ocupado === "preparar" ? "Montando…" : "Revisar elegibilidade"}
          </button>
        </form>
      </div>

      <div style={{ ...S.cards, marginTop: 16 }}>
        {acoes === null ? <p style={S.muted}>Carregando…</p>
          : acoes.length === 0 ? (
            <div style={{ ...S.card, padding: 22 }}>
              <p style={S.muted}>Nenhuma ação ainda. Monte o primeiro público acima.</p>
            </div>
          ) : acoes.map((a) => (
            <div key={a.id} style={S.card}>
              <div style={S.cardHead}>
                <div style={S.cardHeadInfo}>
                  <span style={S.cardNome}>{a.nome}</span>
                  <span style={S.cardCpf}>{a.canal === "WHATSAPP" ? "WhatsApp" : "E-mail"}</span>
                  <span style={S.contadorValor}>{ESTADOS[a.estado]}</span>
                </div>
                <div style={S.cardHeadDir}>
                  <span style={S.contadorAlunos}>{a.alunos} alunos</span>
                  <button style={S.btnGhost} onClick={() => exportarAcao(a)}>Exportar arquivo</button>
                  {a.estado === "EXPORTADA" && (
                    <button style={S.btnGhost} disabled={ocupado === a.id + "ENVIO_CONFIRMADO"}
                            onClick={() => marcar(a.id, "ENVIO_CONFIRMADO")}>
                      Registrar envio confirmado
                    </button>
                  )}
                  {a.estado !== "CANCELADA" && a.estado !== "ENVIO_CONFIRMADO" && (
                    <button style={{ ...S.btnVinc }} onClick={() => marcar(a.id, "CANCELADA")}>Cancelar</button>
                  )}
                  <button style={S.btnVinc} onClick={() => setAberta(aberta === a.id ? null : a.id)}>
                    {aberta === a.id ? "Fechar" : "Ver detalhes"}
                  </button>
                </div>
              </div>

              <div style={{ padding: "12px 16px", display: "flex", gap: 18, flexWrap: "wrap", fontSize: 12.5, color: "var(--rv-texto)" }}>
                <span>Criada em {dataHora(a.criada_em)}</span>
                <span>
                  Atualização financeira usada: {a.atualizacao_financeira?.em
                    ? dataHora(a.atualizacao_financeira.em)
                    : "nenhuma — o público foi montado sem conferência com o Prime"}
                </span>
                {a.exportada_em ? <span>Exportada em {dataHora(a.exportada_em)}</span> : null}
                {a.envio_confirmado_em ? <span>Envio confirmado em {dataHora(a.envio_confirmado_em)}</span> : null}
              </div>

              {a.envio_confirmado_em && (
                <div style={{ padding: "0 16px 14px" }}>
                  <strong style={{ fontSize: 13 }}>
                    Depois do envio: {a.movimento_apos_envio?.titulos || 0} título(s),{" "}
                    {moeda(a.movimento_apos_envio?.valor || 0)} de queda do valor na fonte.
                  </strong>
                  <p style={{ ...S.muted, marginTop: 4, fontSize: 12 }}>
                    Queda de valor não é pagamento, e queda posterior ao envio não prova que o
                    envio causou coisa alguma. E o mesmo título pode estar em mais de uma ação
                    — o consolidado da carteira conta cada alteração uma vez só.
                  </p>
                </div>
              )}

              {aberta === a.id && <Detalhe acaoId={a.id} separados={a.separados}
                                   conferencia={a.conferencia_financeira} />}
            </div>
          ))}
      </div>
    </div>
  );
}

function Detalhe({ acaoId, separados, conferencia }) {
  const [publico, setPublico] = useState(null);
  useEffect(() => {
    supabase.rpc("preventivo_acao_publico", { p_acao_id: acaoId, p_incluidos: true })
      .then(({ data }) => setPublico(data || []));
  }, [acaoId]);

  return (
    <div style={{ padding: "0 16px 16px" }}>
      {Object.keys(conferencia || {}).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h4 style={{ ...S.cardResumo, margin: "0 0 6px" }}>
            Conferência financeira de quem ESTÁ no público
          </h4>
          <ul style={{ ...S.muted, margin: 0, paddingLeft: 18 }}>
            {Object.entries(conferencia).map(([k, n]) => (
              <li key={k}>{n} — {ROTULO_VINCULO[k] || k}</li>
            ))}
          </ul>
        </div>
      )}
      {Object.keys(separados || {}).length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <h4 style={{ ...S.cardResumo, margin: "0 0 6px" }}>Quem ficou de fora, e por quê</h4>
          <ul style={{ ...S.muted, margin: 0, paddingLeft: 18 }}>
            {Object.entries(separados).map(([m, n]) => (
              <li key={m}>{n} — {MOTIVOS[m] || m}</li>
            ))}
          </ul>
        </div>
      )}
      {publico === null ? <p style={S.muted}>Carregando…</p> : (
        <table style={S.tabela}>
          <thead><tr>
            <th style={S.th}>Aluno</th><th style={S.th}>Matrícula</th>
            <th style={S.th}>Contato</th><th style={S.th}>Venc.</th><th style={S.thNum}>Saldo informado</th>
          </tr></thead>
          <tbody>
            {publico.slice(0, 50).map((p, i) => (
              <tr key={i}>
                <td style={S.td}>{p.aluno}</td>
                <td style={S.td}>{p.matricula}</td>
                <td style={S.td}>{p.contato}</td>
                <td style={S.td}>{p.vencimento}</td>
                <td style={S.tdNum}>{moeda(p.saldo_informado)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {publico && publico.length > 50 ? (
        <p style={{ ...S.muted, marginTop: 8, fontSize: 12 }}>
          Mostrando 50 de {publico.length}. O arquivo exportado traz todos.
        </p>
      ) : null}
    </div>
  );
}
