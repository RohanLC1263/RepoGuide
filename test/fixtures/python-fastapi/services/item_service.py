from sqlalchemy.orm import Session

from models.item import DBItem, ItemCreate

class ItemService:
    def __init__(self, db: Session):
        self.db = db

    def create_item(self, item: ItemCreate) -> DBItem:
        db_item = DBItem(name=item.name, description=item.description, price=item.price)
        self.db.add(db_item)
        self.db.commit()
        self.db.refresh(db_item)
        return db_item

    def get_item(self, item_id: int) -> DBItem | None:
        return self.db.query(DBItem).filter(DBItem.id == item_id).first()

    def delete_item(self, item_id: int) -> bool:
        item = self.get_item(item_id)
        if item is None:
            return False
        self.db.delete(item)
        self.db.commit()
        return True

