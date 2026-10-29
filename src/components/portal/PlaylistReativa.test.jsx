// @vitest-environment jsdom
// A1 -- interface da Playlist ReATIVA. O limite de verdade e do banco (ver
// supabase/tests/portal_playlist_limite_tres.test.js); aqui se verifica o que a
// tela promete: contador "X de 3", bloqueio visual da 4a, edicao que nao pede
// vaga e remocao por soft delete.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

const fromMock = vi.fn();
vi.mock("../../services/supabase", () => ({ supabase: { from: (...a) => fromMock(...a) } }));

import PlaylistReativa from "./PlaylistReativa";
import { extrairYoutubeId, contarAtivasDe, LIMITE_MUSICAS } from "./playlist";

const EU = "cobranca05@aelbra.com.br";
const OUTRA = "cobranca06@aelbra.com.br";

const Card = ({ children }) => <div>{children}</div>;
const CabecalhoCard = ({ titulo, acao }) => <div><strong>{titulo}</strong>{acao}</div>;
const S = {};

// Sem `globals: true` no vitest o cleanup do testing-library nao roda sozinho,
// e os renders de um teste apareceriam no seguinte.
afterEach(cleanup);

const musica = (id, email, titulo) => ({
  id, titulo, artista: "Artista", youtube_id: "abc12345678",
  adicionado_por: email === EU ? "Luana" : "Mauricio",
  adicionado_por_email: email, ativo: true, criado_em: `2026-09-30T1${id}:00:00Z`,
});

// supabase.from("portal_playlist").select(...).eq(...).order(...).limit(...) -> {data,error}
// supabase.from("portal_playlist").insert(...) -> {error}
// supabase.from("portal_playlist").update(...).eq(...) -> {error}
function montarSupabase(linhas, { erroInsert = null, erroUpdate = null } = {}) {
  const insert = vi.fn(() => Promise.resolve({ error: erroInsert }));
  const update = vi.fn(() => ({ eq: vi.fn(() => Promise.resolve({ error: erroUpdate })) }));
  const select = vi.fn(() => ({
    eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: linhas, error: null }) }) }),
  }));
  fromMock.mockImplementation(() => ({ select, insert, update }));
  return { insert, update, select };
}

const desenhar = (email = EU, curtidas = undefined) =>
  act(async () => { render(<PlaylistReativa usuario={{ email, nome: "Luana" }} curtidas={curtidas} Card={Card} CabecalhoCard={CabecalhoCard} S={S} />); });

// Dublê do hook useCurtidas. Recebe pares [idDaMusica, {curtidas, euCurti}] --
// e Map de verdade, porque a chave é o id da música como ele vem do banco.
const comCurtidas = (pares = [], extra = {}) => ({
  disponivel: true,
  ocupado: null,
  mapa: new Map(pares),
  alternar: vi.fn(),
  recarregar: vi.fn(),
  ...extra,
});

describe("helpers", () => {
  it("extrairYoutubeId cobre watch, youtu.be, shorts e embed; recusa lixo", () => {
    expect(extrairYoutubeId("https://www.youtube.com/watch?v=gBRi6aZJGj4")).toBe("gBRi6aZJGj4");
    expect(extrairYoutubeId("https://youtu.be/1m_sWJQm2fs")).toBe("1m_sWJQm2fs");
    expect(extrairYoutubeId("https://www.youtube.com/shorts/AVSYcRdHpOA")).toBe("AVSYcRdHpOA");
    expect(extrairYoutubeId("https://www.youtube.com/embed/AVSYcRdHpOA")).toBe("AVSYcRdHpOA");
    expect(extrairYoutubeId("nao e link")).toBeNull();
    expect(extrairYoutubeId("")).toBeNull();
  });

  it("contarAtivasDe conta so as minhas e so as ativas, ignorando caixa do e-mail", () => {
    const lista = [
      musica(1, EU, "A"), musica(2, OUTRA, "B"),
      { ...musica(3, EU.toUpperCase(), "C") },
      { ...musica(4, EU, "D"), ativo: false },
    ];
    expect(contarAtivasDe(lista, EU)).toBe(2);
    expect(contarAtivasDe(lista, OUTRA)).toBe(1);
    expect(contarAtivasDe([], EU)).toBe(0);
    expect(LIMITE_MUSICAS).toBe(3);
  });
});

describe("contador 'Suas músicas: X de 3'", () => {
  beforeEach(() => fromMock.mockReset());

  it("0 de 3 quando a pessoa nao tem musica", async () => {
    montarSupabase([musica(1, OUTRA, "De outra pessoa")]);
    await desenhar();
    expect(screen.getByText(`Suas músicas: 0 de ${LIMITE_MUSICAS}`)).toBeTruthy();
    expect(screen.getByText(/ainda pode incluir 3 músicas/)).toBeTruthy();
  });

  it("2 de 3 e avisa que falta 1", async () => {
    montarSupabase([musica(1, EU, "A"), musica(2, EU, "B"), musica(3, OUTRA, "C")]);
    await desenhar();
    expect(screen.getByText(`Suas músicas: 2 de ${LIMITE_MUSICAS}`)).toBeTruthy();
    expect(screen.getByText(/ainda pode incluir 1 música\b/)).toBeTruthy();
  });

  it("3 de 3 mostra a mensagem de limite", async () => {
    montarSupabase([musica(1, EU, "A"), musica(2, EU, "B"), musica(3, EU, "C")]);
    await desenhar();
    expect(screen.getByText(`Suas músicas: 3 de ${LIMITE_MUSICAS}`)).toBeTruthy();
    expect(screen.getByText(/Você já atingiu o limite de 3 músicas/)).toBeTruthy();
  });
});

describe("bloqueio visual da 4a inclusao", () => {
  beforeEach(() => fromMock.mockReset());

  it("com 3 ativas o botao '+ Minha música' fica desabilitado e nada e enviado", async () => {
    const { insert } = montarSupabase([musica(1, EU, "A"), musica(2, EU, "B"), musica(3, EU, "C")]);
    await desenhar();

    const botao = screen.getByRole("button", { name: "+ Minha música" });
    expect(botao.disabled).toBe(true);
    expect(botao.title).toContain("limite de 3");

    await act(async () => { fireEvent.click(botao); });
    expect(screen.queryByPlaceholderText("Música")).toBeNull(); // formulario nao abriu
    expect(insert).not.toHaveBeenCalled();
  });

  it("com 2 ativas o botao esta liberado e o formulario abre", async () => {
    montarSupabase([musica(1, EU, "A"), musica(2, EU, "B")]);
    await desenhar();

    const botao = screen.getByRole("button", { name: "+ Minha música" });
    expect(botao.disabled).toBe(false);
    await act(async () => { fireEvent.click(botao); });
    expect(screen.getByPlaceholderText("Música")).toBeTruthy();
  });

  it("a 3a inclusao chega ao banco com os campos certos", async () => {
    const { insert } = montarSupabase([musica(1, EU, "A"), musica(2, EU, "B")]);
    await desenhar();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Minha música" })); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Música"), { target: { value: "  Nova  " } });
      fireEvent.change(screen.getByPlaceholderText("Artista"), { target: { value: "  Banda  " } });
      fireEvent.change(screen.getByPlaceholderText("Link do YouTube"), { target: { value: "https://youtu.be/1m_sWJQm2fs" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Adicionar" })); });

    expect(insert).toHaveBeenCalledWith({
      titulo: "Nova", artista: "Banda", youtube_id: "1m_sWJQm2fs",
      adicionado_por: "Luana", adicionado_por_email: EU,
    });
  });

  it("se o banco recusar com PL003, a tela mostra a mensagem de limite", async () => {
    const alerta = vi.spyOn(window, "alert").mockImplementation(() => {});
    montarSupabase([musica(1, EU, "A"), musica(2, EU, "B")], { erroInsert: { code: "PL003", message: "limite" } });
    await desenhar();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Minha música" })); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Música"), { target: { value: "X" } });
      fireEvent.change(screen.getByPlaceholderText("Artista"), { target: { value: "Y" } });
      fireEvent.change(screen.getByPlaceholderText("Link do YouTube"), { target: { value: "https://youtu.be/1m_sWJQm2fs" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Adicionar" })); });

    expect(alerta).toHaveBeenCalledWith("Você já atingiu o limite de 3 músicas.");
    alerta.mockRestore();
  });
});

describe("editar nao consome vaga", () => {
  beforeEach(() => fromMock.mockReset());

  it("mesmo com 3 de 3 a edicao abre e usa update, nao insert", async () => {
    const { insert, update } = montarSupabase([musica(1, EU, "A"), musica(2, EU, "B"), musica(3, EU, "C")]);
    await desenhar();

    // O botao de incluir esta bloqueado, mas Editar existe em cada musica minha.
    expect(screen.getByRole("button", { name: "+ Minha música" }).disabled).toBe(true);
    const editar = screen.getAllByRole("button", { name: "Editar" });
    expect(editar).toHaveLength(3);

    await act(async () => { fireEvent.click(editar[0]); });

    // O formulario abre preenchido com a musica escolhida.
    expect(screen.getByPlaceholderText("Música").value).toBe("A");
    expect(screen.getByPlaceholderText("Link do YouTube").value).toBe("https://www.youtube.com/watch?v=abc12345678");

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Música"), { target: { value: "A editada" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" })); });

    expect(update).toHaveBeenCalledWith({ titulo: "A editada", artista: "Artista", youtube_id: "abc12345678" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("nao oferece Editar/Remover em musica de outra pessoa", async () => {
    montarSupabase([musica(1, OUTRA, "Do Mauricio")]);
    await desenhar();
    expect(screen.queryByRole("button", { name: "Editar" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Remover" })).toBeNull();
  });
});

describe("remover com soft delete", () => {
  beforeEach(() => fromMock.mockReset());

  it("grava ativo = false (nao apaga a linha) e recarrega a lista", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { update, select } = montarSupabase([musica(1, EU, "A"), musica(2, EU, "B"), musica(3, EU, "C")]);
    await desenhar();
    const buscasIniciais = select.mock.calls.length;

    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: "Remover" })[1]); });

    expect(update).toHaveBeenCalledWith({ ativo: false });
    expect(select.mock.calls.length).toBe(buscasIniciais + 1); // recarregou -> vaga liberada na tela
    confirmar.mockRestore();
  });

  it("desistir da confirmacao nao remove nada", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { update } = montarSupabase([musica(1, EU, "A")]);
    await desenhar();

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remover" })); });

    expect(update).not.toHaveBeenCalled();
    confirmar.mockRestore();
  });
});

describe("estados de borda", () => {
  beforeEach(() => fromMock.mockReset());

  it("playlist vazia mostra o convite, sem erro", async () => {
    montarSupabase([]);
    await desenhar();
    expect(screen.getByText(/A playlist começa com a primeira indicação/)).toBeTruthy();
  });

  it("sem sessao identificada nao envia e avisa", async () => {
    const alerta = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { insert } = montarSupabase([]);
    await desenhar("");

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "+ Minha música" })); });
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText("Música"), { target: { value: "X" } });
      fireEvent.change(screen.getByPlaceholderText("Artista"), { target: { value: "Y" } });
      fireEvent.change(screen.getByPlaceholderText("Link do YouTube"), { target: { value: "https://youtu.be/1m_sWJQm2fs" } });
    });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Adicionar" })); });

    expect(insert).not.toHaveBeenCalled();
    expect(alerta).toHaveBeenCalledWith("Sua sessão ainda não foi identificada. Atualize a página e tente novamente.");
    alerta.mockRestore();
  });

  it("erro de leitura mostra a mensagem de indisponibilidade", async () => {
    const select = vi.fn(() => ({
      eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: { code: "42P01" } }) }) }),
    }));
    fromMock.mockImplementation(() => ({ select, insert: vi.fn(), update: vi.fn() }));
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    await desenhar();
    expect(screen.getByText(/Playlist temporariamente indisponível/)).toBeTruthy();
    erro.mockRestore();
  });
});

describe("coração de curtidas (A2)", () => {
  beforeEach(() => fromMock.mockReset());

  it("mostra a contagem da semana e o coração vazio quando ainda não curti", async () => {
    montarSupabase([musica(1, OUTRA, "De outra pessoa")]);
    await desenhar(EU, comCurtidas([[1, { curtidas: 3, euCurti: false }]]));
    expect(screen.getByRole("button", { name: /🤍 3/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /🤍 3/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("coração cheio e aria-pressed quando já curti", async () => {
    montarSupabase([musica(1, OUTRA, "De outra pessoa")]);
    await desenhar(EU, comCurtidas([[1, { curtidas: 5, euCurti: true }]]));
    const b = screen.getByRole("button", { name: /❤️ 5/ });
    expect(b.getAttribute("aria-pressed")).toBe("true");
    expect(b.title).toBe("Retirar minha curtida");
  });

  it("clicar chama alternar com a música e o e-mail de quem está logado", async () => {
    montarSupabase([musica(1, OUTRA, "De outra")]);
    const c = comCurtidas([[1, { curtidas: 0, euCurti: false }]]);
    await desenhar(EU, c);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /🤍 0/ })); });
    expect(c.alternar).toHaveBeenCalledWith(1, EU);
  });

  it("dá para curtir a própria música, e as ações de dono continuam lá", async () => {
    montarSupabase([musica(1, EU, "Minha")]);
    await desenhar(EU, comCurtidas([[1, { curtidas: 1, euCurti: true }]]));
    expect(screen.getByRole("button", { name: /❤️ 1/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Editar" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remover" })).toBeTruthy();
  });

  it("sem curtidas disponíveis (migration não aplicada), nenhum coração aparece", async () => {
    montarSupabase([musica(1, OUTRA, "De outra")]);
    await desenhar(EU, comCurtidas([], { disponivel: false }));
    expect(screen.queryByRole("button", { name: /🤍|❤️/ })).toBeNull();
  });

  it("sem o hook (playlist usada sozinha), a lista continua funcionando", async () => {
    montarSupabase([musica(1, OUTRA, "De outra")]);
    await desenhar(EU, undefined);
    expect(screen.getByText("De outra")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /🤍|❤️/ })).toBeNull();
  });

  it("remover uma música manda reapurar as curtidas (o destaque pode mudar)", async () => {
    const confirmar = vi.spyOn(window, "confirm").mockReturnValue(true);
    montarSupabase([musica(1, EU, "Minha")]);
    const c = comCurtidas([[1, { curtidas: 2, euCurti: false }]]);
    await desenhar(EU, c);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Remover" })); });
    expect(c.recarregar).toHaveBeenCalled();
    confirmar.mockRestore();
  });
});
