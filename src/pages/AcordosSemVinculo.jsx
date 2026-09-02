// Fila dos acordos que ainda não dizem qual mensalidade substituíram.
//
// POR QUE EXISTE. Em 02/09/2026 havia 1.490 acordos ativos sem NENHUM título
// vinculado, R$ 5,96 milhões. O vínculo é feito à mão, na ficha do aluno
// (FinanceiroAluno), e não existia lista que levasse até eles -- a gestão
// garimpava um por um.
//
// ESTA TELA NÃO DECIDE VÍNCULO, e é de propósito. Foi medido: dos 1.490,
// ZERO tem a soma dos títulos abertos batendo com o valor do acordo -- acordo
// carrega juros, desconto e honorário, então nunca fecha com o nominal das
// mensalidades. Regra automática por valor seria chute, e chute aqui já quase
// apagou R$ 337 mil legítimos antes. O que a tela faz é ORDENAR pelo tamanho da
// decisão, e levar você direto à ficha certa.
//
// A ORDEM COMEÇA PELO DINHEIRO QUE JÁ ENTROU. 154 desses acordos já têm parcela
// paga. Sem o vínculo, o sistema não sabe qual mensalidade aquele pagamento
// liquidou -- e em 61 casos o aluno SEGUE com título aberto sendo cobrado.
// Cobrar quem já pagou é o pior erro possível, então esses vêm primeiro.
//
// SEM_CANDIDATO vem escondido por padrão: são acordos onde não existe o outro
// lado do vínculo (aluno sem título na base, ou títulos já em outro acordo).
// Garimpar esses é trabalho impossível, não trabalho pendente -- mas ficam
// acessíveis no filtro para ninguém achar que sumiram.
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import Aluno from "./Aluno";
import DadosAcademicos from "../components/DadosAcademicos";

function moeda(v) {
  return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
function dataCurta(d) {
  if (!d) return "-";
  const [a, m, dia] = String(d).slice(0, 10).split("-");
  return `${dia}/${m}/${a}`;
}

// A ordem aqui é a mesma da RPC. O rótulo explica o que a faixa quer dizer,
// para a fila não virar um código que só quem escreveu entende.
const FAIXAS = [
  { id: "PAGO_E_COBRADO", rotulo: "Pagou e ainda é cobrado", ajuda: "já pagou parcela do acordo e continua com mensalidade aberta" },
  { id: "PAGO", rotulo: "Já pagou", ajuda: "tem parcela paga, sem título aberto sobrando" },
  { id: "FACIL", rotulo: "Fácil", ajuda: "1 ou 2 títulos candidatos" },
  { id: "MEDIO", rotulo: "Médio", ajuda: "3 a 5 candidatos" },
  { id: "DIFICIL", rotulo: "Difícil", ajuda: "6 ou mais candidatos" },
  { id: "SEM_CANDIDATO", rotulo: "Sem contrapartida", ajuda: "não há título aberto para vincular" },
];

export default function AcordosSemVinculo() {
  const [linhas, setLinhas] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  // Começa nas duas faixas de dinheiro que já entrou -- é onde o erro dói.
  const [filtro, setFiltro] = useState("PAGO_E_COBRADO");
  const [fichaId, setFichaId] = useState(null);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    const { data, error } = await supabase.rpc("acordos_sem_vinculo_fila");
    if (error) setErro(error.message);
    setLinhas(data || []);
    setCarregando(false);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const porFaixa = useMemo(() => {
    const m = {};
    for (const l of linhas) m[l.faixa] = (m[l.faixa] || 0) + 1;
    return m;
  }, [linhas]);

  const visiveis = useMemo(
    () => (filtro === "TODOS" ? linhas : linhas.filter((l) => l.faixa === filtro)),
    [linhas, filtro],
  );
  const totalAcordos = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.valor_total || 0), 0),
    [visiveis],
  );
  const totalPago = useMemo(
    () => visiveis.reduce((s, l) => s + Number(l.valor_ja_pago || 0), 0),
    [visiveis],
  );

  // Fecha a ficha e recarrega: se o vínculo foi feito lá dentro, a linha sai da fila.
  function fecharFicha() {
    setFichaId(null);
    carregar();
  }

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Acordos sem vínculo</h1>
          <p style={S.sub}>
            Acordos ativos que não dizem qual mensalidade substituíram. A fila está ordenada
            pelo tamanho da decisão — e começa por quem já pagou, porque aí o risco é cobrar
            de novo. O vínculo em si você faz na ficha, em Financeiro.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={S.barra}>
        <select value={filtro} onChange={(e) => setFiltro(e.target.value)} style={S.select}>
          <option value="TODOS">Todas as faixas ({linhas.length})</option>
          {FAIXAS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.rotulo} ({porFaixa[f.id] || 0})
            </option>
          ))}
        </select>
        <div style={S.contadores}>
          <span style={S.contadorAcordos}>{visiveis.length} acordos</span>
          <span style={S.contadorValor}>{moeda(totalAcordos)}</span>
          {totalPago > 0 ? (
            <span style={S.contadorValor}>{moeda(totalPago)} já pago</span>
          ) : null}
        </div>
      </div>

      {filtro !== "TODOS" ? (
        <p style={S.muted}>{FAIXAS.find((f) => f.id === filtro)?.ajuda}</p>
      ) : null}

      {erro ? <div style={S.erroBox}>{erro}</div> : null}

      {!carregando && visiveis.length === 0 ? (
        <p style={S.muted}>Nada nesta faixa.</p>
      ) : null}

      <div style={S.cards}>
        {visiveis.map((l) => (
          <div key={l.acordo_id} style={S.card}>
            <div style={S.cardHead}>
              <div style={S.cardHeadInfo}>
                <span style={S.cardNome}>{l.nome || "(sem nome)"}</span>
                <span style={S.cardCpf}>{l.cpf || "sem CPF"}</span>
                {l.operador_email ? (
                  <span style={S.cardUnidade}>{l.operador_email}</span>
                ) : (
                  <span style={S.respVazio}>sem responsável</span>
                )}
              </div>
              <div style={S.cardHeadDir}>
                <button type="button" style={S.btnFicha} onClick={() => setFichaId(l.aluno_id)}>
                  Abrir ficha
                </button>
              </div>
            </div>

            <div style={S.cardResumo}>
              <table style={S.tabela}>
                <thead>
                  <tr>
                    <th style={S.th}>Acordo</th>
                    <th style={S.thNum}>Valor</th>
                    <th style={S.thNum}>Já pago</th>
                    <th style={S.thNum}>Candidatos</th>
                    <th style={S.thNum}>Somam</th>
                    <th style={S.th}>Vencimentos</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={S.td}>
                      {l.numero_acordo || "(sem número)"}
                      {l.parcelas_pagas > 0 ? (
                        <span style={S.chipOk}> {l.parcelas_pagas} parcela(s) paga(s)</span>
                      ) : null}
                    </td>
                    <td style={S.tdNum}>{moeda(l.valor_total)}</td>
                    <td style={S.tdNum}>{l.valor_ja_pago > 0 ? moeda(l.valor_ja_pago) : "-"}</td>
                    <td style={S.tdNum}>{l.qtd_candidatos}</td>
                    <td style={S.tdNum}>
                      {l.qtd_candidatos > 0 ? moeda(l.soma_candidatos) : "-"}
                    </td>
                    <td style={S.td}>
                      {l.qtd_candidatos > 0
                        ? `${dataCurta(l.venc_mais_antigo)} a ${dataCurta(l.venc_mais_novo)}`
                        : "-"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </div>

      {fichaId && (
        <div style={S.modalOverlay} onClick={fecharFicha}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno — vincular em Financeiro</span>
              <button
                type="button"
                style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={fecharFicha}
              >
                Fechar ✕
              </button>
            </div>
            <div style={{ padding: "0 16px" }}>
              <DadosAcademicos aluno={{ id: fichaId }} />
            </div>
            <div style={S.modalConteudo}>
              <Aluno fichaEmbedId={fichaId} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
